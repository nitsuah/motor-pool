/**
 * website MCP server
 *
 * Exposes B2B website generation operations as MCP tools:
 * lead discovery, file I/O for generated content, Netlify deployment, invoicing.
 *
 * Claude orchestrates the workflow (pitch copy, site HTML generation) using
 * its own Write tool; these MCP tools handle the external API calls and
 * shell operations that Claude can't do natively.
 *
 * Port: 3201 (WEBSITE_PORT)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR   = join(__dirname, 'scripts');
const TEMPLATES_DIR = join(__dirname, 'templates');
const OUTPUT_DIR    = process.env.WEBSITE_OUTPUT_DIR || join(__dirname, 'output');

const PORT = parseInt(process.env.WEBSITE_PORT || '3201', 10);

// Ensure output dir exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Security: restrict file ops to OUTPUT_DIR ──────────────────────────────────
function safeOutputPath(slug, ...parts) {
  const p = resolve(OUTPUT_DIR, slug, ...parts);
  if (!p.startsWith(resolve(OUTPUT_DIR))) {
    throw new Error(`Path traversal attempt blocked: ${p}`);
  }
  return p;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function runPs1(script, args = {}) {
  // Always inject OutputDir so scripts resolve paths correctly inside the
  // container (/app/scripts/../output == /app/output, the mounted volume)
  // as well as on the host (tools/website/scripts/../output).
  const withOutputDir = { OutputDir: OUTPUT_DIR, ...args };

  const argStr = Object.entries(withOutputDir)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'boolean') return v ? `-${k}` : '';
      return `-${k} "${String(v).replace(/"/g, '`"')}"`;
    })
    .filter(Boolean)
    .join(' ');

  const cmd = `pwsh -File "${SCRIPTS_DIR}/${script}.ps1" ${argStr}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
  return stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
}

// ── MCP server factory ─────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: 'website', version: '1.0.0' }, { maxToolInputElements: 10_000 });

  // ── Tool: discover_leads ────────────────────────────────────────────────────
  server.tool(
    'discover_leads',
    'Find local businesses near a ZIP code using Yelp or Google Places API. ' +
    'Returns a path to the saved JSON lead file and a summary table.',
    {
      zip:         z.string().describe('ZIP code to search near'),
      category:    z.string().default('restaurants').describe(
        'Business category: restaurants, auto, realestate, retail, health, dental, beauty, ' +
        'gym, legal, accounting, contractor, plumber, electrician, landscaping, bakery, etc.'
      ),
      radius:      z.number().int().min(1).max(25).default(5).describe('Search radius in miles'),
      max_results: z.number().int().min(1).max(50).default(40).describe('Max businesses to return'),
      no_website_only: z.boolean().default(false).describe('Only return businesses without a website'),
    },
    async ({ zip, category, radius, max_results, no_website_only }) => {
      const output = await runPs1('discover', {
        Zip: zip,
        Category: category,
        Radius: radius,
        MaxResults: max_results,
        ...(no_website_only ? { NoWebsiteOnly: true } : {}),
      });
      return { content: [{ type: 'text', text: output }] };
    }
  );

  // ── Tool: read_leads ────────────────────────────────────────────────────────
  server.tool(
    'read_leads',
    'Read a saved leads JSON file. Returns the full lead list so Claude can review and select targets.',
    {
      zip:      z.string().describe('ZIP code used in the discovery run'),
      category: z.string().default('restaurants'),
      date:     z.string().optional().describe('Date string YYYYMMDD (defaults to most recent)'),
    },
    async ({ zip, category, date }) => {
      let file;
      if (date) {
        file = join(OUTPUT_DIR, '..', `leads-${zip}-${category.toLowerCase()}-${date}.json`);
      } else {
        // find the most recent matching file
        const files = readdirSync(OUTPUT_DIR).filter(f =>
          f.startsWith(`leads-${zip}-${category.toLowerCase()}-`) && f.endsWith('.json')
        ).sort().reverse();
        if (!files.length) {
          // also check parent (legacy path)
          return { content: [{ type: 'text', text: `No lead files found for ${zip}/${category}. Run discover_leads first.` }] };
        }
        file = join(OUTPUT_DIR, files[0]);
      }
      if (!existsSync(file)) {
        return { content: [{ type: 'text', text: `Lead file not found: ${file}` }] };
      }
      return { content: [{ type: 'text', text: readFileSync(file, 'utf8') }] };
    }
  );

  // ── Tool: save_file ─────────────────────────────────────────────────────────
  server.tool(
    'save_file',
    'Save Claude-generated content (pitch deck HTML, site HTML, email text, etc.) to a client output folder. ' +
    'Always use this after Claude generates website or pitch content.',
    {
      slug:    z.string().describe('Client slug (e.g. "acme-pizza-90210")'),
      subdir:  z.enum(['pitch', 'site', 'invoice', 'scrape']).describe('Output sub-folder'),
      filename: z.string().describe('File name (e.g. "index.html", "cold-email.txt")'),
      content: z.string().describe('File content to write'),
    },
    async ({ slug, subdir, filename, content }) => {
      const dir  = safeOutputPath(slug, subdir);
      const path = safeOutputPath(slug, subdir, filename);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content, 'utf8');
      return { content: [{ type: 'text', text: `✓ Saved: ${path}` }] };
    }
  );

  // ── Tool: read_file ─────────────────────────────────────────────────────────
  server.tool(
    'read_file',
    'Read a previously saved client file (e.g. to review generated site HTML or leads data).',
    {
      slug:     z.string(),
      subdir:   z.enum(['pitch', 'site', 'invoice', 'scrape']),
      filename: z.string(),
    },
    async ({ slug, subdir, filename }) => {
      const path = safeOutputPath(slug, subdir, filename);
      if (!existsSync(path)) {
        return { content: [{ type: 'text', text: `File not found: ${path}` }] };
      }
      return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] };
    }
  );

  // ── Tool: list_client_files ─────────────────────────────────────────────────
  server.tool(
    'list_client_files',
    'List all generated files for a client slug.',
    { slug: z.string() },
    async ({ slug }) => {
      const clientDir = safeOutputPath(slug);
      if (!existsSync(clientDir)) {
        return { content: [{ type: 'text', text: `No output found for slug: ${slug}` }] };
      }
      const lines = [];
      function walk(dir, prefix = '') {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            lines.push(`${prefix}${entry}/`);
            walk(full, prefix + '  ');
          } else {
            lines.push(`${prefix}${entry}  (${(stat.size / 1024).toFixed(1)}KB)`);
          }
        }
      }
      walk(clientDir);
      return { content: [{ type: 'text', text: lines.join('\n') || '(empty)' }] };
    }
  );

  // ── Tool: deploy_site ───────────────────────────────────────────────────────
  server.tool(
    'deploy_site',
    'Deploy a generated site to Netlify. Requires `netlify login` to have been run on the host.',
    {
      slug:      z.string().describe('Client slug matching the output/{slug}/site/ directory'),
      site_name: z.string().optional().describe('Custom Netlify subdomain (slug used if blank)'),
      draft:     z.boolean().default(false).describe('Preview deploy instead of production'),
    },
    async ({ slug, site_name, draft }) => {
      const output = await runPs1('deploy', {
        Slug: slug,
        ...(site_name ? { SiteName: site_name } : {}),
        ...(draft      ? { Draft: true }         : {}),
      });
      return { content: [{ type: 'text', text: output }] };
    }
  );

  // ── Tool: create_invoice ────────────────────────────────────────────────────
  server.tool(
    'create_invoice',
    'Generate a professional HTML invoice for a client. Open in browser and print to PDF.',
    {
      slug:        z.string().describe('Client slug'),
      client_name: z.string().describe('Business name shown on the invoice'),
      amount:      z.number().default(500).describe('Invoice amount in USD'),
      description: z.string().optional().describe('Line item description'),
      monthly:     z.boolean().default(false).describe('Generate monthly $50 maintenance invoice instead'),
    },
    async ({ slug, client_name, amount, description, monthly }) => {
      const output = await runPs1('invoice', {
        Slug: slug,
        ClientName: client_name,
        Amount: amount,
        ...(description ? { Description: description } : {}),
        ...(monthly     ? { Monthly: true }            : {}),
      });
      return { content: [{ type: 'text', text: output }] };
    }
  );

  // ── Tool: read_template ─────────────────────────────────────────────────────
  server.tool(
    'read_template',
    'Read a reference template (pitch structure, site sections guide, cold email, service packages).',
    {
      template: z.enum(['pitch-structure', 'site-sections', 'cold-email', 'service-packages'])
        .describe('Which template to read'),
    },
    async ({ template }) => {
      const ext  = template === 'cold-email' ? 'txt' : 'md';
      const path = join(TEMPLATES_DIR, `${template}.${ext}`);
      if (!existsSync(path)) {
        return { content: [{ type: 'text', text: `Template not found: ${path}` }] };
      }
      return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] };
    }
  );

  // ── Tool: run_setup ─────────────────────────────────────────────────────────
  server.tool(
    'run_setup',
    'Run one-time setup: installs netlify-cli, validates API keys, creates output directory.',
    {
      yelp_key:          z.string().optional(),
      google_places_key: z.string().optional(),
      your_name:         z.string().optional(),
      your_email:        z.string().optional(),
      your_phone:        z.string().optional(),
      your_company:      z.string().optional(),
    },
    async ({ yelp_key, google_places_key, your_name, your_email, your_phone, your_company }) => {
      const output = await runPs1('setup', {
        YelpKey:         yelp_key,
        GooglePlacesKey: google_places_key,
        YourName:        your_name,
        YourEmail:       your_email,
        YourPhone:       your_phone,
        YourCompany:     your_company,
      });
      return { content: [{ type: 'text', text: output }] };
    }
  );

  return server;
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({
  status:     'ok',
  service:    'website',
  output_dir: OUTPUT_DIR,
}));

app.post('/mcp', async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`website MCP server running on port ${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/health`);
  console.log(`  MCP:        http://localhost:${PORT}/mcp`);
  console.log(`  Output dir: ${OUTPUT_DIR}`);
});
