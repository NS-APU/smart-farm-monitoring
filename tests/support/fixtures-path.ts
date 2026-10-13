/** テスト用の合成データ（tests/fixtures）のディレクトリ。 */

import { resolve } from 'node:path';

export const FIXTURES_DIRECTORY = resolve(import.meta.dirname, '../fixtures');
