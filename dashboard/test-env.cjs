const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);

process.env.MP_TEST_SECRET = 'leak-me';

async function test() {
  try {
    const { stdout } = await execAsync('echo "secret=[$MP_TEST_SECRET] path=[${PATH:+set}]"', {
      cwd: process.cwd(),
      shell: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME }
    });
    console.log('stdout:', stdout);
  } catch (e) {
    console.log('error:', e.message);
    console.log('stdout:', e.stdout);
    console.log('stderr:', e.stderr);
  }
}

test();
