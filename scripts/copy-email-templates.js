/**
 * Copy email HTML templates into the build output.
 *
 * `strapi build` compiles TypeScript and emits only .js and .json into
 * `dist/`, so .html templates under `src/` are not carried over. The email
 * service can read the template from the source tree, but copying it here as
 * well keeps `dist/` self-contained for deployments that ship only the build
 * output.
 *
 * Runs automatically as part of `npm run build`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TEMPLATES = ['src/api/portfolio-inquiry/templates/thank-you-email.html'];

let copied = 0;

for (const relative of TEMPLATES) {
  const source = path.join(ROOT, relative);
  const target = path.join(ROOT, 'dist', relative);

  if (!fs.existsSync(source)) {
    console.error(`[copy-email-templates] Missing source template: ${relative}`);
    process.exitCode = 1;
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied++;
  console.log(`[copy-email-templates] ${relative} -> dist/${relative}`);
}

console.log(`[copy-email-templates] Copied ${copied}/${TEMPLATES.length} template(s).`);
