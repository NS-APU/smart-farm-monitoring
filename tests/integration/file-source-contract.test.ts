/** FileSourcePort の契約テストを、ファイルサーバーのモック（ローカルのディレクトリ）に適用する。実アダプタ（Q-002）にも同じ契約を適用する。 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createFaultController } from '../../src/backend/infrastructure/local/faults.ts';
import { createDirectoryFileSource } from '../../src/backend/infrastructure/local/mock-file-server.ts';
import { describeFileSourceContract } from '../support/file-source-contract.ts';
import { TEST_NOW } from '../support/test-context.ts';

describeFileSourceContract('ファイルサーバーのモック', () => {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'smart-farm-contract-'));
  const faults = createFaultController();
  return {
    source: createDirectoryFileSource({
      rootDirectory,
      faults,
      clock: createControllableClock(TEST_NOW),
    }),
    putFile(sourceId, name, content, modifiedAt) {
      const directory = join(rootDirectory, sourceId);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, name);
      writeFileSync(path, content, 'utf8');
      utimesSync(path, modifiedAt, modifiedAt);
    },
    setDown() {
      faults.set({ mode: 'DOWN' });
    },
  };
});
