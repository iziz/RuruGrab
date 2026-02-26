import { execSync } from 'child_process';
import fs from 'fs';
try {
  const output = execSync('npx tauri build --help').toString();
  fs.writeFileSync('tauri_help.txt', output);
} catch (e) {
  fs.writeFileSync('tauri_help.txt', e.stdout ? e.stdout.toString() : e.message);
}
