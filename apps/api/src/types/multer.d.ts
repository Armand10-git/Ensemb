/**
 * Déclaration ambiante minimale pour multer v2.x (pas de @types/multer disponible).
 * Fournit memoryStorage et l'interface Express.Multer.File utilisée dans les contrôleurs.
 */

// Augmentation du namespace Express global (doit être dans un fichier script, pas module)
declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
      destination?: string;
      filename?: string;
      path?: string;
    }
  }
}

declare module 'multer' {
  type StorageEngine = object;

  interface Options {
    storage?: StorageEngine;
    fileFilter?: (
      req: unknown,
      file: Express.Multer.File,
      callback: (error: Error | null, acceptFile: boolean) => void,
    ) => void;
    limits?: { fileSize?: number };
  }

  function memoryStorage(): StorageEngine;

  export { memoryStorage };
  export default function multer(options?: Options): unknown;
}
