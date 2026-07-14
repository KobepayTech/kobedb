import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';

export interface AccessClaims {
  sub: string; // user id
  email: string;
  role: string;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.jwtAccessTtl });
}

export function verifyAccessToken(token: string): AccessClaims & { exp: number } {
  return jwt.verify(token, config.jwtSecret) as AccessClaims & { exp: number };
}

export function newRefreshToken(): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + config.jwtRefreshTtl * 1000);
  return { token, expiresAt };
}
