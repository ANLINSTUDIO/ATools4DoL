const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 工具 ----------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// ---------- 压缩 ----------

function minifyJs(filePath) {
  let terserPath;
  try {
    // 优先用扩展自带的 terser
    terserPath = require.resolve('terser/bin/terser');
  } catch {
    terserPath = 'terser'; // 退回全局
  }

  try {
    const out = execFileSync(
      process.execPath,                 // 用当前 node 跑
      [terserPath, filePath, '--compress', '--mangle', '--ecma', '2017'],
      { encoding: 'utf-8', timeout: 120000 }
    );
    if (!out.trim()) return null;
    return out;
  } catch (e) {
    console.warn('terser 失败:', e.message);
    return null;
  }
}

function minifyCss(filePath) {
  try {
    let css = fs.readFileSync(filePath, 'utf-8');
    const tokens = [];
    css = css.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, (m) => {
      tokens.push(m);
      return `\x00${tokens.length - 1}\x00`;
    });
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    css = css.replace(/\s+/g, ' ');
    css = css.replace(/\s*([{}:;,>~+])\s*/g, '$1');
    css = css.replace(/;}/g, '}');
    css = css.trim();
    css = css.replace(/\x00(\d+)\x00/g, (_, i) => tokens[Number(i)]);
    return css;
  } catch (e) {
    console.warn('CSS 压缩失败:', e.message);
    return null;
  }
}

// ---------- 收集图片 ----------

function collectImages(imgDir, baseDir) {
  if (!fs.existsSync(imgDir)) return [];
  return walkFiles(imgDir)
    .map((f) => path.relative(baseDir, f).split(path.sep).join('/'))
    .sort();
}

// ---------- ZIP 生成（archiver v8）----------

function buildZip(baseDir, zipPath, minify, log) {
  const { ZipArchive } = require('archiver');

  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      log(`打包完成: ${zipPath} (${archive.pointer()} 字节)`);
      resolve();
    });
    archive.on('error', reject);
    archive.pipe(output);

    const files = walkFiles(baseDir);
    for (const f of files) {
      const rel = path.relative(baseDir, f).split(path.sep).join('/');

      if (minify && rel.endsWith('.js')) {
        const mini = minifyJs(f);
        if (mini) {
          archive.append(mini, { name: rel });
          log(`已压缩: ${rel}`);
          continue;
        }
      }
      if (minify && rel.endsWith('.css')) {
        const mini = minifyCss(f);
        if (mini) {
          archive.append(mini, { name: rel });
          log(`已压缩: ${rel}`);
          continue;
        }
      }
      archive.file(f, { name: rel });
    }

    archive.finalize();
  });
}

// ---------- 打包主流程 ----------

async function packMod(config, workspaceRoot, log = console.log) {
  const baseDir = path.isAbsolute(config.source)
    ? config.source
    : path.join(workspaceRoot, config.source);

  const bootPath = path.join(baseDir, 'boot.json');
  if (!fs.existsSync(bootPath)) {
    throw new Error(`未找到 boot.json: ${bootPath}`);
  }

  const imgDir = path.join(baseDir, config.imgDir || 'img');
  const imgFiles = collectImages(imgDir, baseDir);
  log(`收集图片: ${imgFiles.length} 个`);

  const boot = readJson(bootPath);
  if (config.updateBoot !== false) {
    boot.imgFileList = imgFiles;
    fs.writeFileSync(bootPath, JSON.stringify(boot, null, 4), 'utf-8');
    log(`已更新 boot.json`);
  }

  const version = boot.version || 'unknown';
  // 打包名：优先 boot.json 的 packName 模板（支持 ${name}/${version}/${nickName} 变量）；
  // 没配 packName 才用「name-v版本」老格式。模板渲染后再补默认后缀，防止用户忘了写。
  const vars = { name: boot.name || config.modName || 'Mod', version, nickName: boot.nickName || '' };
  let zipName = boot.packName
    ? boot.packName.replace(/\$\{(\w+)\}/g, (k, v) => (v in vars ? vars[v] : k))
    : `${vars.name}-v${version}.mod.zip`;
  if (!/\.mod\.zip$/i.test(zipName)) zipName += '.mod.zip';
  const outDir = path.isAbsolute(config.output)
    ? config.output
    : path.join(workspaceRoot, config.output || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);

  await buildZip(baseDir, zipPath, config.minify, log);

  return { zipPath, version, imgCount: imgFiles.length };
}

module.exports = { packMod, readJson, collectImages };