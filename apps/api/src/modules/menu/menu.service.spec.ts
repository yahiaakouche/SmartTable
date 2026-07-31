import { MenuService } from './menu.service';
import { MenuRepository } from './menu.repository';
import { ImageStorageService } from './image-storage.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import { EntityNotFoundException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for menu business rules (Engineering Standards §10 — mandatory
 * for money-adjacent logic): price-change auditing (FR38), availability
 * event semantics (Contract §4 — emitted only after the write), delete
 * semantics (soft categories / hard products), and cross-entity validation.
 */
describe('MenuService', () => {
  let service: MenuService;
  let repository: jest.Mocked<MenuRepository>;
  let imageStorage: jest.Mocked<ImageStorageService>;
  let audit: jest.Mocked<AuditService>;
  let events: jest.Mocked<DomainEventsService>;

  const categoryRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cat-1',
    nameAr: 'مشروبات',
    nameFr: 'Boissons',
    sortOrder: 0,
    isActive: true,
    ...overrides,
  });

  const productRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'prod-1',
    categoryId: 'cat-1',
    nameAr: 'قهوة',
    nameFr: 'Café',
    priceMinor: 15000,
    imagePath: 'old-image.jpg',
    isAvailable: true,
    sortOrder: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      listCategories: jest.fn(),
      findCategoryById: jest.fn(),
      insertCategory: jest.fn(),
      updateCategory: jest.fn(),
      listProducts: jest.fn(),
      listAvailableProductsByCategory: jest.fn(),
      findProductById: jest.fn(),
      insertProduct: jest.fn(),
      updateProduct: jest.fn(),
      hardDeleteProduct: jest.fn(),
    } as jest.Mocked<MenuRepository>;
    imageStorage = {
      validateAndStore: jest.fn(),
      readStored: jest.fn(),
      deleteStored: jest.fn(),
    } as unknown as jest.Mocked<ImageStorageService>;
    audit = { append: jest.fn() } as unknown as jest.Mocked<AuditService>;
    events = {
      emitProductAvailabilityChanged: jest.fn(),
      emitTableStatusChanged: jest.fn(),
      on: jest.fn(),
    } as unknown as jest.Mocked<DomainEventsService>;

    service = new MenuService(repository, imageStorage, audit, events);
  });

  it('rejects creating a product under a missing or inactive category', async () => {
    repository.findCategoryById.mockResolvedValue(categoryRow({ isActive: false }) as never);

    await expect(
      service.createProduct({ nameAr: 'x', nameFr: 'x', priceMinor: 100, categoryId: 'cat-1' }, undefined),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(repository.insertProduct).not.toHaveBeenCalled();
  });

  it('creates a product without an image (image_path nullable per schema)', async () => {
    repository.findCategoryById.mockResolvedValue(categoryRow() as never);
    repository.insertProduct.mockResolvedValue(productRow({ imagePath: null }) as never);

    const result = await service.createProduct(
      { nameAr: 'قهوة', nameFr: 'Café', priceMinor: 15000, categoryId: 'cat-1' },
      undefined,
    );

    expect(imageStorage.validateAndStore).not.toHaveBeenCalled();
    expect(repository.insertProduct).toHaveBeenCalledWith(expect.objectContaining({ imagePath: null, priceMinor: 15000 }));
    expect(result.priceMinor).toBe(15000);
  });

  it('audits a price change with old/new values (FR38)', async () => {
    repository.findProductById.mockResolvedValue(productRow() as never);
    repository.updateProduct.mockResolvedValue(productRow({ priceMinor: 18000 }) as never);

    await service.updateProduct('prod-1', { priceMinor: 18000 }, undefined, 'owner-1');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmployeeId: 'owner-1',
        entityType: 'product',
        entityId: 'prod-1',
        action: 'price_changed',
        oldValueJson: JSON.stringify({ priceMinor: 15000 }),
        newValueJson: JSON.stringify({ priceMinor: 18000 }),
      }),
    );
  });

  it('does NOT audit when the price is unchanged', async () => {
    repository.findProductById.mockResolvedValue(productRow() as never);
    repository.updateProduct.mockResolvedValue(productRow() as never);

    await service.updateProduct('prod-1', { priceMinor: 15000, nameFr: 'Café au lait' }, undefined, 'owner-1');

    expect(audit.append).not.toHaveBeenCalled();
  });

  it('emits product.availability_changed strictly AFTER the write commits (Contract §4)', async () => {
    const callOrder: string[] = [];
    repository.findProductById.mockResolvedValue(productRow() as never);
    repository.updateProduct.mockImplementation(async () => {
      callOrder.push('db');
      return productRow({ isAvailable: false }) as never;
    });
    events.emitProductAvailabilityChanged.mockImplementation(() => callOrder.push('event'));

    await service.updateProduct('prod-1', { isAvailable: false }, undefined, 'owner-1');

    expect(callOrder).toEqual(['db', 'event']);
    expect(events.emitProductAvailabilityChanged).toHaveBeenCalledWith({ productId: 'prod-1', isAvailable: false });
  });

  it('does NOT emit when availability is unchanged', async () => {
    repository.findProductById.mockResolvedValue(productRow() as never);
    repository.updateProduct.mockResolvedValue(productRow() as never);

    await service.updateProduct('prod-1', { isAvailable: true }, undefined, 'owner-1');

    expect(events.emitProductAvailabilityChanged).not.toHaveBeenCalled();
  });

  it('deletes the replaced image file after a successful image update', async () => {
    repository.findProductById.mockResolvedValue(productRow() as never);
    repository.updateProduct.mockResolvedValue(productRow({ imagePath: 'new-image.webp' }) as never);
    imageStorage.validateAndStore.mockResolvedValue('new-image.webp');

    await service.updateProduct('prod-1', {}, Buffer.from('img'), 'owner-1');

    expect(imageStorage.deleteStored).toHaveBeenCalledWith('old-image.jpg');
  });

  it('hard-deletes products (ADR-012) and cleans up the stored image', async () => {
    repository.findProductById.mockResolvedValue(productRow() as never);

    await service.removeProduct('prod-1');

    expect(repository.hardDeleteProduct).toHaveBeenCalledWith('prod-1');
    expect(imageStorage.deleteStored).toHaveBeenCalledWith('old-image.jpg');
    expect(repository.updateProduct).not.toHaveBeenCalled(); // never a soft-delete path for products
  });

  it('soft-deletes categories (Cross-Cutting Rule 5)', async () => {
    repository.findCategoryById.mockResolvedValue(categoryRow() as never);

    await service.removeCategory('cat-1');

    expect(repository.updateCategory).toHaveBeenCalledWith('cat-1', { isActive: false });
  });

  it('throws NOT_FOUND when removing a missing category or product', async () => {
    repository.findCategoryById.mockResolvedValue(undefined);
    repository.findProductById.mockResolvedValue(undefined);

    await expect(service.removeCategory('nope')).rejects.toBeInstanceOf(EntityNotFoundException);
    await expect(service.removeProduct('nope')).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('public menu exposes ONLY active categories and ONLY available products (FR31)', async () => {
    repository.listCategories.mockResolvedValue([
      categoryRow({ id: 'cat-1' }),
      categoryRow({ id: 'cat-2', isActive: false, nameFr: 'Hidden' }),
    ] as never);
    repository.listAvailableProductsByCategory.mockResolvedValue([
      productRow({ id: 'p1', categoryId: 'cat-1' }),
      productRow({ id: 'p2', categoryId: 'cat-2' }),
    ] as never);

    const menu = await service.getPublicMenu();

    expect(menu).toHaveLength(1);
    expect(menu[0].id).toBe('cat-1');
    expect(menu[0].products.map((p) => p.id)).toEqual(['p1']);
    // no staff-only fields leak into the customer shape
    expect(menu[0].products[0]).not.toHaveProperty('isAvailable');
    expect(menu[0].products[0]).not.toHaveProperty('sortOrder');
  });
});
