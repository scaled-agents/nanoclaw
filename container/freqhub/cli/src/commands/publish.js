import fs from 'fs';
import path from 'path';
import { parse } from '../lib/frontmatter.js';
import { verifyHash } from '../lib/hash.js';
import { loadConfig, getPublishTarget } from '../lib/config.js';

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub API helper with auth and error handling.
 */
async function githubAPI(method, apiPath, body = null) {
  const token = process.env.GITHUB_TOKEN;
  const url = `${GITHUB_API}${apiPath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (resp.status === 404) return { status: 404, data: null };
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${method} ${apiPath}: ${resp.status} ${text}`);
  }
  return { status: resp.status, data: await resp.json() };
}

/**
 * Get a file from the GitHub repo. Returns { content, sha } or null.
 */
async function getRemoteFile(target, filePath) {
  const resp = await githubAPI(
    'GET',
    `/repos/${target.owner}/${target.repo}/contents/${filePath}?ref=${target.branch}`
  );
  if (resp.status === 404) return null;
  return {
    content: Buffer.from(resp.data.content, 'base64').toString('utf-8'),
    sha: resp.data.sha,
  };
}

/**
 * Create or update a file in the GitHub repo.
 */
async function putRemoteFile(target, filePath, content, message, sha = null) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: target.branch,
  };
  if (sha) body.sha = sha;
  return githubAPI(
    'PUT',
    `/repos/${target.owner}/${target.repo}/contents/${filePath}`,
    body
  );
}

/**
 * Recursively find all .sdna genome files in a directory.
 */
function findGenomeFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findGenomeFiles(fullPath));
    } else if (entry.name === 'GENOME.sdna' || entry.name.endsWith('.sdna')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Slugify a name for use as a directory name.
 */
function slugify(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Publish attested genomes to the shared FreqHub GitHub registry.
 */
export async function publishGenomes(contentDir, opts = {}) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error(
      'GITHUB_TOKEN not set. Add GITHUB_TOKEN=ghp_... to your .env file. Required scope: repo (or public_repo for public repos).'
    );
  }

  const config = loadConfig();
  const target = getPublishTarget();
  const operator = config.operator || 'unknown';
  const files = findGenomeFiles(contentDir);

  const published = [];
  const stats = { total: 0, new: 0, updated: 0, skipped: 0, filtered: 0 };

  for (const filePath of files) {
    stats.total++;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parse(raw);

    // Only publish attested genomes
    if (frontmatter.attestation?.status !== 'attested') {
      published.push({ name: frontmatter.name || path.basename(filePath), hash: frontmatter.hash, status: 'unattested' });
      stats.filtered++;
      continue;
    }

    // Verify hash integrity
    if (!verifyHash(body, frontmatter.hash)) {
      published.push({ name: frontmatter.name, hash: frontmatter.hash, status: 'hash_invalid' });
      stats.filtered++;
      continue;
    }

    const genomeName = slugify(frontmatter.name || path.basename(path.dirname(filePath)));
    const remotePath = `content/${operator}/${genomeName}/GENOME.sdna`;

    if (opts.dryRun) {
      published.push({ name: frontmatter.name, hash: frontmatter.hash, path: remotePath, status: 'would_publish' });
      stats.new++;
      continue;
    }

    // Check if already published (dedup by hash)
    const existing = await getRemoteFile(target, remotePath);

    if (existing && !opts.force) {
      const { frontmatter: remoteFM } = parse(existing.content);
      if (remoteFM.hash === frontmatter.hash) {
        published.push({ name: frontmatter.name, hash: frontmatter.hash, path: remotePath, status: 'skipped' });
        stats.skipped++;
        continue;
      }
      // Different hash — update
      await putRemoteFile(
        target, remotePath, raw,
        `update: ${genomeName} (${frontmatter.hash})`,
        existing.sha
      );
      published.push({ name: frontmatter.name, hash: frontmatter.hash, path: remotePath, status: 'updated' });
      stats.updated++;
    } else {
      // New or forced
      const sha = existing?.sha || null;
      await putRemoteFile(
        target, remotePath, raw,
        `publish: ${genomeName} (${frontmatter.hash})`,
        sha
      );
      published.push({ name: frontmatter.name, hash: frontmatter.hash, path: remotePath, status: existing ? 'updated' : 'new' });
      if (existing) stats.updated++;
      else stats.new++;
    }

    // Upload attestation sidecar if it exists
    const attestDir = path.dirname(filePath);
    const attestFile = path.join(attestDir, 'ATTESTATION.json');
    if (fs.existsSync(attestFile)) {
      const attestContent = fs.readFileSync(attestFile, 'utf-8');
      const remoteAttestPath = `content/${operator}/${genomeName}/ATTESTATION.json`;
      const existingAttest = await getRemoteFile(target, remoteAttestPath);
      await putRemoteFile(
        target, remoteAttestPath, attestContent,
        `attest: ${genomeName} (${frontmatter.hash})`,
        existingAttest?.sha || null
      );
    }
  }

  // Update remote registry.json
  let registryUpdated = false;
  if (!opts.dryRun && (stats.new > 0 || stats.updated > 0)) {
    const localRegistryPath = path.join(path.dirname(contentDir), 'dist', 'registry.json');
    if (fs.existsSync(localRegistryPath)) {
      const localRegistry = fs.readFileSync(localRegistryPath, 'utf-8');
      const existingRegistry = await getRemoteFile(target, 'dist/registry.json');

      if (existingRegistry) {
        // Merge: add local genomes not already in remote
        const remote = JSON.parse(existingRegistry.content);
        const local = JSON.parse(localRegistry);
        const remoteHashes = new Set(remote.genomes.map(g => g.hash));

        for (const g of local.genomes) {
          if (!remoteHashes.has(g.hash)) {
            remote.genomes.push(g);
          }
        }
        remote.stats.total = remote.genomes.length;
        remote.built = new Date().toISOString();

        await putRemoteFile(
          target, 'dist/registry.json',
          JSON.stringify(remote, null, 2),
          `registry: add ${stats.new} new, ${stats.updated} updated genomes`,
          existingRegistry.sha
        );
      } else {
        // First publish — push local registry as-is
        await putRemoteFile(
          target, 'dist/registry.json',
          localRegistry,
          `registry: initial publish (${stats.new} genomes)`
        );
      }
      registryUpdated = true;
    }
  }

  return { published, registryUpdated, stats };
}
