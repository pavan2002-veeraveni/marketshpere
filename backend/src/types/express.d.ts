import { RoleName } from '@prisma/client';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: RoleName[];
  permissions: string[];
  sellerId?: string | null;
  sellerStatus?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      rawBody?: string;
      user?: AuthenticatedUser;
    }
  }
}

export {};
