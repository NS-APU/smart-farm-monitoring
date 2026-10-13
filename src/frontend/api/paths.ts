/**
 * API のパスの組み立て（パスの中の値は、すべて encodeURIComponent で符号化する。付け忘れを防ぐため、
 * 値を含むパスは、ここで組み立てる）。固定のパスは、各呼び出しに直接書く。
 */

const segment = encodeURIComponent;

export const API_PATHS = {
  viewpoint: (viewpointId: string) => `/viewpoints/${segment(viewpointId)}`,
  viewpointSeries: (viewpointId: string) => `/viewpoints/${segment(viewpointId)}/series`,
  viewpointCriteria: (viewpointId: string) => `/viewpoints/${segment(viewpointId)}/criteria`,
  viewpointCriteriaReset: (viewpointId: string) =>
    `/viewpoints/${segment(viewpointId)}/criteria/reset`,
  notificationRead: (notificationId: string) => `/notifications/${segment(notificationId)}/read`,
  manualEntry: (entryId: string) => `/manual-entries/${segment(entryId)}`,
  equipment: (equipmentId: string) => `/equipment/${segment(equipmentId)}`,
  statusCode: (code: string) => `/status-codes/${segment(code)}`,
  user: (userId: string) => `/users/${segment(userId)}`,
  ingestionTest: (sourceId: string) => `/ingestion/${segment(sourceId)}/test`,
  ingestionRun: (sourceId: string) => `/ingestion/${segment(sourceId)}/run`,
} as const;
