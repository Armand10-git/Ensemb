/** Réponse paginée canonique — utilisée par BackupModule et tout futur module listant des ressources. */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
