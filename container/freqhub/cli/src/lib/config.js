import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const CONFIG_DIR = path.join(os.homedir(), '.sdna');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const ANNOTATIONS_FILE = path.join(CONFIG_DIR, 'annotations.json');

const DEFAULT_CONFIG = {
  sources: [
    {
      name: 'community',
      url: 'https://raw.githubusercontent.com/adaptiveX-gh/freqhub/main/dist',
    },
  ],
  operator: 'wolfclaw',
  author: 'wolfclaw-agent-01',
  freqtrade_user_data: '',
};

/**
 * Load user config from ~/.sdna/config.yaml.
 * Returns defaults if file doesn't exist.
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...yaml.load(raw) };
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to ~/.sdna/config.yaml.
 */
export function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: -1 }));
}

/**
 * Load annotations from ~/.sdna/annotations.json.
 */
export function loadAnnotations() {
  try {
    if (fs.existsSync(ANNOTATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, 'utf-8'));
    }
  } catch {
    // Fall through
  }
  return {};
}

/**
 * Save annotations to ~/.sdna/annotations.json.
 */
export function saveAnnotations(annotations) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2));
}

export { CONFIG_DIR, CONFIG_FILE };
