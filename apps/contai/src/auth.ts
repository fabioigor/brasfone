import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { Db } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL = "12h";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: "staff" | "client";
  companyId: number | null;
  /** Firm profile: contabilista | coordenador | toc (null for clients). */
  profile?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function issueToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * Short-lived token that lets the browser load a document inline (iframe /
 * img cannot send the Authorization header). Scoped to one document.
 */
export function issuePreviewToken(documentId: number, userId: number): string {
  return jwt.sign({ kind: "preview", doc: documentId, sub: userId }, JWT_SECRET, { expiresIn: "20m" });
}

export function verifyPreviewToken(token: string, documentId: number): boolean {
  try {
    const p = jwt.verify(token, JWT_SECRET) as any;
    return p.kind === "preview" && Number(p.doc) === documentId;
  } catch {
    return false;
  }
}

export function authenticate(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Sessão em falta. Inicie sessão." });
    }
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
      const row = db.prepare("SELECT id, email, name, role, company_id, profile FROM users WHERE id = ?").get(payload.sub) as any;
      if (!row) return res.status(401).json({ error: "Utilizador desconhecido." });
      req.user = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        companyId: row.company_id,
        profile: row.profile ?? (row.role === "staff" ? "toc" : null),
      };
      next();
    } catch {
      return res.status(401).json({ error: "Sessão inválida ou expirada." });
    }
  };
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "staff") {
    return res.status(403).json({ error: "Acesso reservado ao gabinete." });
  }
  next();
}

/** Company scope: staff sees everything; a client only their own company. */
export function scopedCompanyId(req: Request, requested: number | null): number | null {
  if (req.user?.role === "staff") return requested;
  return req.user?.companyId ?? -1;
}

export type Profile = "contabilista" | "coordenador" | "toc";
const RANK: Record<Profile, number> = { contabilista: 0, coordenador: 1, toc: 2 };

/** Requires a firm profile of at least the given level (toc > coordenador > contabilista). */
export function requireProfile(min: Profile) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "staff") return res.status(403).json({ error: "Acesso reservado ao gabinete." });
    const p = (req.user.profile ?? "toc") as Profile;
    if ((RANK[p] ?? 0) < RANK[min]) return res.status(403).json({ error: min === "toc" ? "Acesso reservado ao TOC responsável." : "Acesso reservado ao coordenador ou ao TOC responsável." });
    next();
  };
}
