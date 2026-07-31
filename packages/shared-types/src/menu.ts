/**
 * Menu contract types (categories + products) — API Contract Design §3/§6.
 * Response DTOs are explicit allow-lists: DB entities never cross the wire.
 * Money is integer minor units on the wire, always (FR36, Contract §6) —
 * display formatting is a frontend concern only.
 */

export interface CategoryDto {
  id: string;
  nameAr: string;
  nameFr: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ProductDto {
  id: string;
  categoryId: string | null;
  nameAr: string;
  nameFr: string;
  priceMinor: number;
  imagePath: string | null;
  isAvailable: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCategoryRequest {
  nameAr: string;
  nameFr: string;
  sortOrder?: number;
}

export interface UpdateCategoryRequest {
  nameAr?: string;
  nameFr?: string;
  sortOrder?: number;
}

/** Multipart requests carry these as text fields alongside the optional
 * `image` file part; the API-side DTO transforms them before validation. */
export interface CreateProductRequest {
  nameAr: string;
  nameFr: string;
  priceMinor: number;
  categoryId?: string;
  sortOrder?: number;
}

export interface UpdateProductRequest {
  nameAr?: string;
  nameFr?: string;
  priceMinor?: number;
  categoryId?: string;
  isAvailable?: boolean;
  sortOrder?: number;
}

/** Customer-facing menu (GET /public/menu/:qrToken) — unauthenticated,
 * contains ONLY available products, never staff-only fields (FR2, FR31). */
export interface PublicMenuProductDto {
  id: string;
  nameAr: string;
  nameFr: string;
  priceMinor: number;
  imagePath: string | null;
}

export interface PublicMenuCategoryDto {
  id: string;
  nameAr: string;
  nameFr: string;
  sortOrder: number;
  products: PublicMenuProductDto[];
}

export interface PublicMenuDto {
  table: { id: string; label: string; hallName: string };
  categories: PublicMenuCategoryDto[];
}
