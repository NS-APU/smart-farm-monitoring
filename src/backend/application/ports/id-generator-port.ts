/** 識別子の生成のポート。テストで固定・連番にできるようにする。 */
export interface IdGeneratorPort {
  /** 一意な識別子を返す。 */
  next(): string;
}
