/** 認証・ユーザーのスキーマ。FR-9、functional-specification.md 3.13・3.14。 */

import { z } from 'zod';
import { PERMISSIONS } from '../constants/permissions.ts';
import { IsoDateTimeSchema, UserIdSchema } from './common.ts';

/** パスワードの条件: 8文字以上で、英大文字・英小文字・数字を含む（FR-9.2）。 */
export const PASSWORD_MIN_LENGTH = 8;
/** 長すぎる入力で、ハッシュの計算・メモリを消費させないための上限（V-009）。 */
export const PASSWORD_MAX_LENGTH = 128;
/** リフレッシュトークンの上限（発行するトークンは、43文字程度）。 */
export const REFRESH_TOKEN_MAX_LENGTH = 256;

export function findPasswordPolicyViolation(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `パスワードは${PASSWORD_MIN_LENGTH}文字以上で指定してください`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `パスワードは${PASSWORD_MAX_LENGTH}文字以内で指定してください`;
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'パスワードは英大文字・英小文字・数字を含めてください';
  }
  return null;
}

export const PasswordSchema = z.string().superRefine((password, context) => {
  const violation = findPasswordPolicyViolation(password);
  if (violation !== null) {
    context.addIssue({ code: 'custom', message: violation });
  }
});

export const LoginRequestSchema = z.object({
  userId: z.string().min(1, 'ユーザーIDを入力してください').max(100, 'ユーザーIDが長すぎます'),
  password: z
    .string()
    .min(1, 'パスワードを入力してください')
    .max(PASSWORD_MAX_LENGTH, 'パスワードが長すぎます'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(REFRESH_TOKEN_MAX_LENGTH),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** 認証済みの利用者（権限はロールの設定から導出する）。 */
export const AuthenticatedUserSchema = z.object({
  userId: UserIdSchema,
  userName: z.string(),
  role: z.string(),
  permissions: z.array(z.enum(PERMISSIONS)),
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshTokenExpiresAt: IsoDateTimeSchema,
  user: AuthenticatedUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** パスワードのハッシュを含まない、公開用のユーザー情報。 */
export const PublicUserSchema = z.object({
  userId: UserIdSchema,
  userName: z.string(),
  role: z.string(),
  lastLoginAt: IsoDateTimeSchema.optional(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

const UserNameSchema = z
  .string()
  .trim()
  .min(1, 'ユーザー名は必須です')
  .max(200, 'ユーザー名は200文字以内で指定してください');
const RoleIdSchema = z.string().min(1, 'ロールを選択してください');

/** ユーザー管理の入力（FR-9.4。functional-specification.md 3.13）。 */
export const UserCreateRequestSchema = z.object({
  userId: UserIdSchema,
  userName: UserNameSchema,
  password: PasswordSchema,
  role: RoleIdSchema,
});
export type UserCreateRequest = z.infer<typeof UserCreateRequestSchema>;

/** PUT /users/{userId}。パスワードは、変更する場合のみ指定する。 */
export const UserUpdateRequestSchema = z.object({
  userName: UserNameSchema,
  password: PasswordSchema.optional(),
  role: RoleIdSchema,
});
export type UserUpdateRequest = z.infer<typeof UserUpdateRequestSchema>;

export const RoleOptionSchema = z.object({ roleId: z.string(), name: z.string() });

export const UserListResponseSchema = z.object({
  items: z.array(PublicUserSchema),
  roles: z.array(RoleOptionSchema),
});
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
