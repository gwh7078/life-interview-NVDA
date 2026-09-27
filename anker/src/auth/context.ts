/** Backend-resolved identity. Never construct this from request body/query fields. */
export interface AuthContext {
  accountId: string;
  userId: string;
}
