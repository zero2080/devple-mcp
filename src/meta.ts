import { createRequire } from 'node:module';

interface PackageJson {
  name: string;
  version: string;
  description?: string;
}

// src/ 와 dist/ 어디서 실행되든 루트의 package.json 을 가리킨다.
const pkg = createRequire(import.meta.url)('../package.json') as PackageJson;

export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;
export const SERVER_DESCRIPTION = pkg.description ?? '';
