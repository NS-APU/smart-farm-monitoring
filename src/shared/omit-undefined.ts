/**
 * 値が undefined のキーを除いたオブジェクトを返す。
 * `exactOptionalPropertyTypes` のもとで、「値があるときだけキーを足す」ために使う
 * （`...omitUndefined({ cursor })`）。値が undefined のキーは、結果に含まれない。
 */

/** undefined を取りうるキーは、省略できるキー（undefined を含まない型）にする。 */
export type OmitUndefined<Source extends object> = {
  [Key in keyof Source as undefined extends Source[Key] ? never : Key]: Source[Key];
} & {
  [Key in keyof Source as undefined extends Source[Key] ? Key : never]?: Exclude<
    Source[Key],
    undefined
  >;
};

export function omitUndefined<Source extends object>(source: Source): OmitUndefined<Source> {
  // Object.entries / fromEntries は、キーと値の型を保たないため、結果の型を断定する。
  // undefined の値だけを除くので、OmitUndefined<Source> の型と一致する
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as OmitUndefined<Source>;
}
