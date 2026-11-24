import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 源码里的相对导入没有写扩展名，Node 20 不会自动补上。
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parent = context.parentURL
      ? fileURLToPath(context.parentURL)
      : process.cwd();
    const base = path.resolve(path.dirname(parent), specifier);
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      return nextResolve(`${specifier}/index.js`, context);
    }
    if (!path.extname(specifier) && fs.existsSync(`${base}.js`)) {
      return nextResolve(`${specifier}.js`, context);
    }
  }
  return nextResolve(specifier, context);
}
