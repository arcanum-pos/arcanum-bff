import type { AuthResult, NormalizedIdentity } from '../types';

interface WhoamiResult {
  success: boolean;
  status: number;
  data: NormalizedIdentity | { error: string };
}

export async function processWhoAmi(
  _request: Request,
  authResult: AuthResult,
  _env: unknown
): Promise<WhoamiResult> {
  if (authResult.authMethod === 'public') {
    return { success: false, status: 401, data: { error: 'Unauthorized - Valid session or token required' } };
  }

  if (!authResult.identity) {
    return { success: false, status: 401, data: { error: 'Invalid or expired access token' } };
  }

  return {
    success: true,
    status: 200,
    data: authResult.identity,
  };
}
