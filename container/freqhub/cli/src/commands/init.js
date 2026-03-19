import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeHash, displayHash } from '../lib/hash.js';
import { parse, serialize } from '../lib/frontmatter.js';
import { loadConfig } from '../lib/config.js';
import {
  parseStrategyFile,
  loadCompanionConfig,
  buildSkeletonBody,
} from '../lib/strategy-parser.js';

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
 * Create a new genome from an existing FreqTrade .py strategy file.
 */
export function initFromStrategy(options = {}) {
  const { fromStrategy, name, output } = options;

  if (!fs.existsSync(fromStrategy)) {
    throw new Error(`Strategy file not found: ${fromStrategy}`);
  }

  const pyContent = fs.readFileSync(fromStrategy, 'utf-8');
  const fileName = path.basename(fromStrategy);

  // Parse strategy attributes via regex
  const attrs = parseStrategyFile(pyContent, fileName);

  // Try to load companion config
  const companionConfig = loadCompanionConfig(fromStrategy);

  // Build skeleton genome body
  const body = buildSkeletonBody(attrs, companionConfig, fileName);

  // Build frontmatter
  const config = loadConfig();
  const frontmatter = {
    name: name || attrs.className || path.basename(fromStrategy, '.py'),
    description: `Imported from ${fileName}`,
    version: '1.0.0',
    operator: config.operator,
    author: config.author,
    created: new Date().toISOString(),
    parent: null,
    tags: ['imported'],
  };

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

  return { content, hash: frontmatter.hash, name: frontmatter.name };
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
