import { config } from '../config.js';

const DEFAULTS = new Set([
  'super-secret-change-me-please-32-chars-min',
  'service-role-change-me',
  'change-me',
]);

export interface SecurityIssue {
  level: 'error' | 'warn';
  message: string;
}

/**
 * Inspect security-sensitive configuration at startup. In production
 * (NODE_ENV=production) default/weak secrets are hard errors that stop boot;
 * elsewhere they are warnings so local dev stays frictionless.
 */
export function auditSecurity(): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const prod = process.env.NODE_ENV === 'production';

  const flag = (cond: boolean, message: string) => {
    if (cond) issues.push({ level: prod ? 'error' : 'warn', message });
  };

  flag(DEFAULTS.has(config.jwtSecret), 'JWT_SECRET is the built-in default — set a unique value');
  flag(config.jwtSecret.length < 32, 'JWT_SECRET should be at least 32 characters');
  flag(DEFAULTS.has(config.serviceRoleKey), 'SERVICE_ROLE_KEY is the built-in default — set a unique value');
  flag(config.serviceRoleKey.length < 16, 'SERVICE_ROLE_KEY should be at least 16 characters');

  return issues;
}

/** Log audit results; throw in production if any hard errors are present. */
export function enforceSecurity(log: { warn: (m: string) => void; error: (m: string) => void }): void {
  const issues = auditSecurity();
  for (const i of issues) {
    const msg = `[security] ${i.message}`;
    if (i.level === 'error') log.error(msg);
    else log.warn(msg);
  }
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    throw new Error(
      `refusing to start in production with ${errors.length} security issue(s); fix the above or unset NODE_ENV=production`,
    );
  }
}
