/**
 * テストでは、応答の本文（JSON）を、検証前の値（unknown）として扱う。
 * 標準の型（any）のままだと、検証せずに値を使えてしまうため、型を絞る。
 */
export {};

declare global {
  interface Body {
    json(): Promise<unknown>;
  }
}
