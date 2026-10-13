/**
 * ログインのセッション（トークン）の保持。タブを閉じると消えるよう、sessionStorage を使う。
 * ブラウザの保存領域は、使えない・空になることがあるため、読み書きは try/catch で囲み、
 * 保存できなくても動作する（その場合は、再読み込みで再ログインが必要）。
 * 暫定: トークンを保存領域に置く方式は、XSS への備えが前提（dangerouslySetInnerHTML を使わない）。
 * Cognito へ移行する際に、Cookie（HttpOnly）方式も含めて見直す（dev_spec.md 4章）。
 */

import { LoginResponseSchema, type LoginResponse } from '@smart-farm/shared/schemas/auth';
import type { SessionAccess } from './client.ts';

export const SESSION_STORAGE_KEY = 'smart-farm.session';

export function createSessionStorageAccess(storage: Storage | undefined): SessionAccess {
  let cached: LoginResponse | null = null;
  let loaded = false;

  function load(): LoginResponse | null {
    try {
      const raw = storage?.getItem(SESSION_STORAGE_KEY);
      if (raw === null || raw === undefined) {
        return null;
      }
      const parsed = LoginResponseSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return {
    get() {
      if (!loaded) {
        cached = load();
        loaded = true;
      }
      return cached;
    },
    set(session) {
      cached = session;
      loaded = true;
      try {
        storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch {
        // 保存できない環境では、メモリ上のみで保持する
      }
    },
    clear() {
      cached = null;
      loaded = true;
      try {
        storage?.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // 削除できない場合も、メモリ上は消えている
      }
    },
  };
}

/** ブラウザの sessionStorage を返す。アクセスが禁止されている環境では undefined。 */
export function resolveSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
