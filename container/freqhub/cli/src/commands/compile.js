import fs from 'fs';
import path from 'path';
import { parse } from '../lib/frontmatter.js';
import { compileToFreqtrade } from '../lib/compile-freqtrade.js';

/**
 * Compile a .sdna genome to a FreqTrade IStrategy Python file.
 */
export function compileGenome(sourcePath, options = {}) {
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  const { frontmatter, body } = parse(raw);

  const result = compileToFreqtrade(frontmatter, body);

  if (options.output) {
    const outputDir = options.output;
    fs.mkdirSync(outputDir, { recursive: true });

    const pyPath = path.join(outputDir, `${result.strategyName}.py`);
    fs.writeFileSync(pyPath, result.python);

    const configPath = path.join(outputDir, `config_${result.strategyName}.json`);
    fs.writeFileSync(configPath, JSON.stringify(result.config, null, 2));

    return {
      strategyName: result.strategyName,
      path: pyPath,
      configPath,
    };
  }

  return result;
}
