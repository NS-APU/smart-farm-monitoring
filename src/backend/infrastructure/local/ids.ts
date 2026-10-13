/** 識別子の生成の実装（IdGeneratorPort）。 */

import { randomUUID } from 'node:crypto';
import type { IdGeneratorPort } from '../../application/ports/id-generator-port.ts';

export function createUuidGenerator(): IdGeneratorPort {
  return { next: () => randomUUID() };
}

/** 連番の識別子（テスト用。`prefix-000001`）。ログ・並べ替えで順序が読み取れる。 */
export function createSequentialIdGenerator(prefix = 'id'): IdGeneratorPort {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `${prefix}-${String(counter).padStart(6, '0')}`;
    },
  };
}
