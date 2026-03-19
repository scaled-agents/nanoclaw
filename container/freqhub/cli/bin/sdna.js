#!/usr/bin/env node

import { Command } from 'commander';
import { initGenome, listTemplates } from '../src/commands/init.js';
import { forkGenome } from '../src/commands/fork.js';
import { diffGenomes, formatDiff } from '../src/commands/diff.js';

const program = new Command();

program
  .name('sdna')
  .description('FreqHub — CLI for StrategyDNA genome management')
  .version('0.1.0');

// --- init ---
program
  .command('init')
  .description('Create a new genome from a template')
  .option('-t, --template <name>', 'template name', 'rsi-basic')
  .option('-n, --name <name>', 'strategy name')
  .option('-p, --pairs <pairs>', 'comma-separated trading pairs')
  .option('--timeframe <tf>', 'candle timeframe')
  .option('-o, --output <path>', 'output file path')
  .action((opts) => {
    try {
      const result = initGenome(opts);
      if (result.content) {
        process.stdout.write(result.content);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- fork ---
program
  .command('fork <source>')
  .description('Fork a genome with mutations')
  .option('-m, --mutations <json>', 'JSON mutations (dot-path keys)')
  .option('-n, --name <name>', 'name for the forked genome')
  .option('-o, --output <path>', 'output file path')
  .action((source, opts) => {
    try {
      const result = forkGenome(source, opts);
      if (result.content) {
        process.stdout.write(result.content);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- diff ---
program
  .command('diff <a> <b>')
  .description('Semantic diff between two genomes')
  .option('--json', 'output as JSON')
  .action((a, b, opts) => {
    try {
      const result = diffGenomes(a, b);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatDiff(result));
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- templates ---
program
  .command('templates')
  .description('List available genome templates')
  .action(() => {
    const templates = listTemplates();
    for (const t of templates) {
      console.log(`  ${t.name.padEnd(20)} ${t.description}`);
      if (t.tags.length) console.log(`${''.padEnd(22)}tags: ${t.tags.join(', ')}`);
    }
  });

// --- build (placeholder for Phase 2) ---
program
  .command('build <content-dir>')
  .description('Build registry.json from content directory')
  .option('-o, --output <dir>', 'output directory', 'dist')
  .action(async (contentDir, opts) => {
    const { buildRegistry } = await import('../src/commands/build.js');
    try {
      const result = buildRegistry(contentDir, opts.output);
      console.log(JSON.stringify(result.stats, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- search (placeholder for Phase 2) ---
program
  .command('search [query]')
  .description('Search the registry for genomes')
  .option('--tag <tag>', 'filter by tag')
  .option('--operator <op>', 'filter by operator')
  .option('--min-sharpe <n>', 'minimum walk-forward Sharpe', parseFloat)
  .option('--timeframe <tf>', 'filter by timeframe')
  .option('--pair <pair>', 'filter by trading pair')
  .option('--json', 'output as JSON')
  .action(async (query, opts) => {
    const { searchRegistry } = await import('../src/commands/search.js');
    try {
      const results = await searchRegistry(query, opts);
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) {
          const sharpe = r.attestation?.walk_forward_sharpe?.toFixed(2) || '-';
          console.log(`  ${r.id.padEnd(30)} Sharpe: ${sharpe.padEnd(6)} ${(r.tags || []).join(', ')}`);
        }
        console.log(`\n${results.length} genome(s) found.`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- get (placeholder for Phase 2) ---
program
  .command('get <id>')
  .description('Fetch a genome by registry ID')
  .option('--json', 'output JSON body only')
  .option('--full', 'include attestation')
  .action(async (id, opts) => {
    const { getGenome } = await import('../src/commands/get.js');
    try {
      const result = await getGenome(id, opts);
      process.stdout.write(result);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- leaderboard (placeholder for Phase 2) ---
program
  .command('leaderboard')
  .description('Show strategy leaderboard')
  .option('--top <n>', 'number of entries', parseInt, 10)
  .option('--tier <tier>', 'filter by quality tier')
  .action(async (opts) => {
    const { showLeaderboard } = await import('../src/commands/leaderboard.js');
    try {
      await showLeaderboard(opts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- frontier (placeholder for Phase 2) ---
program
  .command('frontier')
  .description('Show most promising unexplored DAG branches')
  .option('--top <n>', 'number of entries', parseInt, 10)
  .action(async (opts) => {
    const { showFrontier } = await import('../src/commands/frontier.js');
    try {
      await showFrontier(opts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- compile (placeholder for Phase 3) ---
program
  .command('compile <source>')
  .description('Compile genome to FreqTrade IStrategy Python file')
  .option('-o, --output <dir>', 'output directory')
  .action(async (source, opts) => {
    const { compileGenome } = await import('../src/commands/compile.js');
    try {
      const result = compileGenome(source, opts);
      if (!opts.output) process.stdout.write(result.python);
      else console.log(JSON.stringify({ strategy: result.strategyName, path: result.path }, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- verify ---
program
  .command('verify <source>')
  .description('Verify genome integrity (hash check)')
  .option('--json', 'output as JSON')
  .action(async (source, opts) => {
    const { verifyGenome } = await import('../src/commands/verify.js');
    try {
      const result = verifyGenome(source);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const status = result.hashValid ? 'VALID' : 'INVALID';
        console.log(`  ${result.name}: ${status}`);
        console.log(`  ${result.message}`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// --- attest ---
program
  .command('attest <source>')
  .description('Add attestation data to a genome')
  .option('--sharpe <n>', 'walk-forward Sharpe ratio', parseFloat)
  .option('--win-rate <n>', 'win rate percentage', parseFloat)
  .option('--max-drawdown <n>', 'maximum drawdown', parseFloat)
  .option('--profit-factor <n>', 'profit factor', parseFloat)
  .option('--total-trades <n>', 'total number of trades', parseInt)
  .action(async (source, opts) => {
    const { attestGenome } = await import('../src/commands/attest.js');
    try {
      const data = {};
      if (opts.sharpe != null) data.walk_forward_sharpe = opts.sharpe;
      if (opts.winRate != null) data.win_rate = opts.winRate;
      if (opts.maxDrawdown != null) data.max_drawdown = opts.maxDrawdown;
      if (opts.profitFactor != null) data.profit_factor = opts.profitFactor;
      if (opts.totalTrades != null) data.total_trades = opts.totalTrades;
      const result = attestGenome(source, data);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
