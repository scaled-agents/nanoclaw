import yaml from 'js-yaml';

const FRONTMATTER_DELIMITER = '---';

/**
 * Parse a .sdna file into { frontmatter, body }.
 * @param {string} content - Full .sdna file content
 * @returns {{ frontmatter: object, body: object }}
 */
export function parse(content) {
  const trimmed = content.trim();

  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    // No frontmatter — treat entire content as JSON body
    return { frontmatter: {}, body: JSON.parse(trimmed) };
  }

  // Find the closing --- delimiter
  const secondDelim = trimmed.indexOf(
    FRONTMATTER_DELIMITER,
    FRONTMATTER_DELIMITER.length + 1,
  );
  if (secondDelim === -1) {
    throw new Error('Malformed .sdna file: missing closing --- delimiter');
  }

  const yamlStr = trimmed.slice(FRONTMATTER_DELIMITER.length, secondDelim).trim();
  const jsonStr = trimmed.slice(secondDelim + FRONTMATTER_DELIMITER.length).trim();

  const frontmatter = yaml.load(yamlStr) || {};
  const body = JSON.parse(jsonStr);

  return { frontmatter, body };
}

/**
 * Serialize frontmatter + body back to .sdna format.
 * @param {object} frontmatter - YAML frontmatter object
 * @param {object} body - JSON body object
 * @returns {string} Full .sdna file content
 */
export function serialize(frontmatter, body) {
  const yamlStr = yaml.dump(frontmatter, {
    lineWidth: -1, // Don't wrap lines
    noRefs: true,
    sortKeys: true,
  }).trim();

  // Body is stored as pretty-printed JSON for readability in files
  const jsonStr = JSON.stringify(body, null, 2);

  return `---\n${yamlStr}\n---\n${jsonStr}\n`;
}

/**
 * Read a .sdna file and return parsed genome with both parts.
 */
export function parseGenome(content) {
  const { frontmatter, body } = parse(content);
  return {
    // Identity from frontmatter
    name: frontmatter.name || '',
    description: frontmatter.description || '',
    author: frontmatter.author || '',
    operator: frontmatter.operator || '',
    created: frontmatter.created || new Date().toISOString(),
    tags: frontmatter.tags || [],
    parent: frontmatter.parent || null,
    hash: frontmatter.hash || null,
    attestation: frontmatter.attestation || { status: 'unattested' },
    runtime: frontmatter.runtime || 'freqtrade',
    freqtrade_version: frontmatter.freqtrade_version || '>=2024.1',
    sdna_version: frontmatter.sdna_version || '0.1',

    // Strategy body
    body,

    // Raw parts for re-serialization
    _frontmatter: frontmatter,
  };
}
