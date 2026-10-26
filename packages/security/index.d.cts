export function hashPassword(password:string):Promise<string>;
export function verifyPassword(password:string,stored:string):Promise<boolean>;
export function secret(name:string):string;
export interface Security {sign(claims:Record<string,unknown>,expiresIn?:string):string;verify(token:string):Record<string,unknown>;}
export function createSecurity(jwt:unknown,key:string,audience:string):Security;
