import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeHash, displayHash } from '../lib/hash.js';
import { parse, serialize } from '../lib/frontmatter.js';
import { loadConfig } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

/**
 * List available templates.
 */
export function listTemplates() {
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.sdna'));
  return files.map(f => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8');
    const { frontmatter } = parse(content);
    return {
      name: path.basename(f, '.sdna'),
      description: frontmatter.description || '',
      tags: frontmatter.tags || [],
    };
  });
}

/**
 * Create a new genome from a template.
 */
export function initGenome(options = {}) {
  const {
    template = 'rsi-basic',
    name,
    pairs,
    timeframe,
    output,
  } = options;

  const config = loadConfig();

  // Load template
  const templatePath = path.join(TEMPLATES_DIR, `${template}.sdna`);
  if (!fs.existsSync(templatePath)) {
    const available = listTemplates().map(t => t.name).join(', ');
    throw new Error(`Template "${template}" not found. Available: ${available}`);
  }

  const raw = fs.readFileSync(templatePath, 'utf-8');
  const { frontmatter, body } = parse(raw);

  // Apply overrides
  if (name) frontmatter.name = name;
  if (pairs) body.pairs = pairs.split(',').map(p => p.trim());
  if (timeframe) body.timeframe = timeframe;

  // Set operator/author from config
  frontmatter.operator = config.operator;
  frontmatter.author = config.author;
  frontmatter.created = new Date().toISOString();
  frontmatter.parent = null;

  // Compute hash from body
  const hash = computeHash(body);
  frontmatter.hash = displayHash(hash);

  // Serialize
  const content = serialize(frontmatter, body);

  if (output) {
    const dir = path.dirname(output);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(output, content);
    return { path: output, hash: frontmatter.hash, name: frontmatter.name };
  }

  // Print to stdout
  return { content, hash: frontmatter.hash, name: frontmatter.name };
}
