import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (status) throw new Error('工作区存在未提交修改，请提交后再生成发布包');

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const outputDir = join(root, 'dist', 'deploy');
const archive = join(outputDir, `lottery-web-${commit}.tar.gz`);
mkdirSync(outputDir, { recursive: true });
execFileSync('git', ['archive', '--format=tar.gz', `--output=${archive}`, 'HEAD'], { cwd: root, stdio: 'inherit' });

const content = readFileSync(archive);
const manifest = {
  commit,
  sha256: createHash('sha256').update(content).digest('hex'),
  size: content.length,
  createdAt: new Date().toISOString()
};
writeFileSync(`${archive}.json`, JSON.stringify(manifest, null, 2), 'utf8');
process.stdout.write(`${archive}\n${archive}.json\n`);
