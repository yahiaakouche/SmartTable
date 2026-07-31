import { Inject, Injectable } from '@nestjs/common';
import type {
  CategoryDto,
  CreateCategoryRequest,
  CreateProductRequest,
  ProductDto,
  PublicMenuCategoryDto,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from '@smarttable/shared-types';
import { MENU_REPOSITORY, MenuRepository, ProductFilter } from './menu.repository';
import { ImageStorageService } from './image-storage.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import { EntityNotFoundException } from '../../common/exceptions/domain.exception';

type CategoryRow = Awaited<ReturnType<MenuRepository['findCategoryById']>> & {};
type ProductRow = Awaited<ReturnType<MenuRepository['findProductById']>> & {};

/**
 * Menu administration (FR19, FR31) — bilingual categories and products.
 *
 * Frozen rules enforced here:
 *  - Categories are SOFT-deleted (historically-referenced entity); products
 *    are HARD-deleted because order_items carry immutable snapshots (ADR-012).
 *  - Money is integer minor units end to end (FR36) — validated at the DTO,
 *    CHECK-constrained at the database, never float anywhere between.
 *  - Every price change is audited with old/new values (FR38).
 *  - Availability changes emit `product.availability_changed` on the internal
 *    bus AFTER the write commits (API Contract §4 binding rule) — the
 *    Socket.IO bridge lands with the real-time step (Step 3.2 ruling R4).
 */
@Injectable()
export class MenuService {
  constructor(
    @Inject(MENU_REPOSITORY) private readonly menuRepository: MenuRepository,
    private readonly imageStorage: ImageStorageService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
  ) {}

  // ------------------------------------------------------------- categories

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.menuRepository.listCategories();
    return rows.map((row) => this.categoryToDto(row));
  }

  async createCategory(input: CreateCategoryRequest): Promise<CategoryDto> {
    const row = await this.menuRepository.insertCategory({
      nameAr: input.nameAr,
      nameFr: input.nameFr,
      sortOrder: input.sortOrder ?? 0,
    });
    return this.categoryToDto(row);
  }

  async updateCategory(id: string, changes: UpdateCategoryRequest): Promise<CategoryDto> {
    const existing = await this.menuRepository.findCategoryById(id);
    if (!existing) throw new EntityNotFoundException('category', id);
    const updated = await this.menuRepository.updateCategory(id, changes);
    return this.categoryToDto(updated!);
  }

  /** Soft delete — the category row stays for historical referential
   * integrity; products keep pointing at it (FK hard delete never fires). */
  async removeCategory(id: string): Promise<void> {
    const existing = await this.menuRepository.findCategoryById(id);
    if (!existing) throw new EntityNotFoundException('category', id);
    await this.menuRepository.updateCategory(id, { isActive: false });
  }

  // --------------------------------------------------------------- products

  async listProducts(
    filter: ProductFilter,
    page: number,
    pageSize: number,
  ): Promise<{ products: ProductDto[]; total: number }> {
    const { rows, total } = await this.menuRepository.listProducts(filter, page, pageSize);
    return { products: rows.map((row) => this.productToDto(row)), total };
  }

  async createProduct(input: CreateProductRequest, imageBuffer: Buffer | undefined): Promise<ProductDto> {
    const categoryId = await this.requireActiveCategory(input.categoryId);
    const imagePath = imageBuffer ? await this.imageStorage.validateAndStore(imageBuffer) : null;
    const row = await this.menuRepository.insertProduct({
      categoryId,
      nameAr: input.nameAr,
      nameFr: input.nameFr,
      priceMinor: input.priceMinor,
      imagePath,
      sortOrder: input.sortOrder ?? 0,
    });
    return this.productToDto(row);
  }

  async updateProduct(
    id: string,
    changes: UpdateProductRequest,
    imageBuffer: Buffer | undefined,
    actorEmployeeId: string,
  ): Promise<ProductDto> {
    const existing = await this.menuRepository.findProductById(id);
    if (!existing) throw new EntityNotFoundException('product', id);

    const categoryId =
      changes.categoryId !== undefined ? await this.requireActiveCategory(changes.categoryId) : undefined;
    const newImagePath = imageBuffer ? await this.imageStorage.validateAndStore(imageBuffer) : undefined;

    const updated = await this.menuRepository.updateProduct(id, {
      ...(changes.nameAr !== undefined ? { nameAr: changes.nameAr } : {}),
      ...(changes.nameFr !== undefined ? { nameFr: changes.nameFr } : {}),
      ...(changes.priceMinor !== undefined ? { priceMinor: changes.priceMinor } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(changes.isAvailable !== undefined ? { isAvailable: changes.isAvailable } : {}),
      ...(changes.sortOrder !== undefined ? { sortOrder: changes.sortOrder } : {}),
      ...(newImagePath !== undefined ? { imagePath: newImagePath } : {}),
    });

    // FR38 — price changes are audited with old/new values.
    if (changes.priceMinor !== undefined && changes.priceMinor !== existing.priceMinor) {
      await this.audit.append({
        actorEmployeeId,
        entityType: 'product',
        entityId: id,
        action: 'price_changed',
        oldValueJson: JSON.stringify({ priceMinor: existing.priceMinor }),
        newValueJson: JSON.stringify({ priceMinor: changes.priceMinor }),
      });
    }

    // Contract §4 — emitted strictly after the write above has committed.
    if (changes.isAvailable !== undefined && changes.isAvailable !== existing.isAvailable) {
      this.events.emitProductAvailabilityChanged({ productId: id, isAvailable: changes.isAvailable });
    }

    // The replaced image is orphaned once the row points at the new file.
    if (newImagePath !== undefined && existing.imagePath) {
      await this.imageStorage.deleteStored(existing.imagePath);
    }

    return this.productToDto(updated!);
  }

  /** HARD delete (ADR-012) — legal because order_items store immutable
   * snapshots; historical reports can never be distorted by this. The FK
   * `ON DELETE SET NULL` keeps analytics joins alive for surviving data. */
  async removeProduct(id: string): Promise<void> {
    const existing = await this.menuRepository.findProductById(id);
    if (!existing) throw new EntityNotFoundException('product', id);
    await this.menuRepository.hardDeleteProduct(id);
    if (existing.imagePath) {
      await this.imageStorage.deleteStored(existing.imagePath);
    }
  }

  /** Customer-facing read (FR2, FR31): active categories with ONLY their
   * available products. Consumed by the tables module's public endpoint. */
  async getPublicMenu(): Promise<PublicMenuCategoryDto[]> {
    const [allCategories, availableProducts] = await Promise.all([
      this.menuRepository.listCategories(),
      this.menuRepository.listAvailableProductsByCategory(),
    ]);
    return allCategories
      .filter((category) => category.isActive)
      .map((category) => ({
        id: category.id,
        nameAr: category.nameAr,
        nameFr: category.nameFr,
        sortOrder: category.sortOrder,
        products: availableProducts
          .filter((product) => product.categoryId === category.id)
          .map((product) => ({
            id: product.id,
            nameAr: product.nameAr,
            nameFr: product.nameFr,
            priceMinor: product.priceMinor,
            imagePath: product.imagePath,
          })),
      }));
  }

  // ----------------------------------------------------------------- helpers

  /** Cross-entity truth at the service layer (ES §6): a product may only
   * point at an existing, active category — or at none (nullable FK). */
  private async requireActiveCategory(categoryId: string | null | undefined): Promise<string | null> {
    if (categoryId === undefined || categoryId === null) return null;
    const category = await this.menuRepository.findCategoryById(categoryId);
    if (!category || !category.isActive) throw new EntityNotFoundException('category', categoryId);
    return category.id;
  }

  private categoryToDto(row: CategoryRow): CategoryDto {
    return {
      id: row!.id,
      nameAr: row!.nameAr,
      nameFr: row!.nameFr,
      sortOrder: row!.sortOrder,
      isActive: row!.isActive,
    };
  }

  private productToDto(row: ProductRow): ProductDto {
    return {
      id: row!.id,
      categoryId: row!.categoryId,
      nameAr: row!.nameAr,
      nameFr: row!.nameFr,
      priceMinor: row!.priceMinor,
      imagePath: row!.imagePath,
      isAvailable: row!.isAvailable,
      sortOrder: row!.sortOrder,
      createdAt: row!.createdAt,
      updatedAt: row!.updatedAt,
    };
  }
}
