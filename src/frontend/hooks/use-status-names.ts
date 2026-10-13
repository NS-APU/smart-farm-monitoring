/**
 * ステータスコードの名称の表（コード値 → 名称）。値の表示で、ステータスコードを名称にするために使う。
 * ステータスコードの管理（SC-12）での変更を、約1分で反映する。
 */

import { useCallback } from 'react';
import { getStatusCodes } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePolling } from './use-polling.ts';

const STATUS_CODE_REFRESH_MS = 60_000;

export function useStatusNames(): ReadonlyMap<string, string> {
  const { api } = useAuth();
  const fetchStatusCodes = useCallback(() => getStatusCodes(api), [api]);
  const statusCodes = usePolling(fetchStatusCodes, STATUS_CODE_REFRESH_MS);
  return new Map(statusCodes.data?.items.map((item) => [item.code, item.name]));
}
