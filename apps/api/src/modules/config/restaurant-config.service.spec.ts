import type { RestaurantProfileDto } from '@smarttable/shared-types';
import { RestaurantConfigService } from './restaurant-config.service';
import { ConfigRepository, RestaurantProfileRow } from './restaurant-config.repository';
import { EntityNotFoundException, ValidationFailedException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the config service (Step 3.10, Engineering Standards §10):
 * the B3(a) 404 semantics, the D3 effective-change/no-op discipline, the D4
 * logo ordering (validate-store first, release the old file only after the
 * commit), the D8 changed-fields-only audit, and the D7 post-commit
 * broadcast carrying the full updated DTO.
 */
describe('RestaurantConfigService', () => {
  let service: RestaurantConfigService;
  let repository: jest.Mocked<ConfigRepository>;
  let imageStorage: { validateAndStore: jest.Mock; deleteStored: jest.Mock };
  let events: { emitRestaurantProfileChanged: jest.Mock };
  let audit: { append: jest.Mock };

  const profileRow = (overrides: Partial<RestaurantProfileRow> = {}): RestaurantProfileRow => ({
    id: 'profile-1',
    name: 'Restaurant El Djazair',
    logoPath: 'old-logo.png',
    primaryColor: '#111111',
    secondaryColor: '#eeeeee',
    currencyCode: 'DZD',
    taxRatePercent: 1900,
    defaultLanguage: 'ar',
    setupCompletedAt: null,
    updatedAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      findProfile: jest.fn(),
      updateProfile: jest.fn(),
    } as unknown as jest.Mocked<ConfigRepository>;
    imageStorage = {
      validateAndStore: jest.fn(),
      deleteStored: jest.fn().mockResolvedValue(undefined),
    };
    events = { emitRestaurantProfileChanged: jest.fn() };
    audit = { append: jest.fn().mockResolvedValue(undefined) };

    service = new RestaurantConfigService(repository, imageStorage as never, events as never, audit as never);
  });

  it('GET returns the profile DTO; 404 (NOT_FOUND) when the row does not exist (B3(a))', async () => {
    repository.findProfile.mockResolvedValue(profileRow());
    const profile = await service.getProfile();
    expect(profile).toMatchObject({ id: 'profile-1', name: 'Restaurant El Djazair', taxRatePercent: 1900, defaultLanguage: 'ar' });

    repository.findProfile.mockResolvedValue(null);
    await expect(service.getProfile()).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('PATCH on a missing row is a 404 before anything else runs (B3(a))', async () => {
    repository.findProfile.mockResolvedValue(null);
    await expect(service.updateProfile('emp-owner', { name: 'New Name' })).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(repository.updateProfile).not.toHaveBeenCalled();
    expect(imageStorage.validateAndStore).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(events.emitRestaurantProfileChanged).not.toHaveBeenCalled();
  });

  it('rejects a PATCH with no field and no file (D3 — 400 VALIDATION_FAILED)', async () => {
    repository.findProfile.mockResolvedValue(profileRow());
    await expect(service.updateProfile('emp-owner', {})).rejects.toBeInstanceOf(ValidationFailedException);
    expect(repository.updateProfile).not.toHaveBeenCalled();
  });

  it('writes only EFFECTIVE changes (D3): restated values never reach the repository', async () => {
    const row = profileRow();
    repository.findProfile.mockResolvedValue(row);
    repository.updateProfile.mockImplementation(async (_id, changes) => ({ ...row, ...changes, updatedAt: 2000 }));

    const result = await service.updateProfile('emp-owner', {
      name: 'Restaurant El Djazair', // identical — must be dropped
      taxRatePercent: 900,
    });

    expect(repository.updateProfile).toHaveBeenCalledWith('profile-1', { taxRatePercent: 900 });
    expect(result.taxRatePercent).toBe(900);
    expect(result.updatedAt).toBe(2000);
  });

  it('a true no-op PATCH: 200 with the current DTO, no write, no audit, no broadcast (D3)', async () => {
    const row = profileRow();
    repository.findProfile.mockResolvedValue(row);

    const result = await service.updateProfile('emp-owner', { name: row.name, primaryColor: row.primaryColor });

    expect(result).toEqual({
      id: 'profile-1',
      name: 'Restaurant El Djazair',
      logoPath: 'old-logo.png',
      primaryColor: '#111111',
      secondaryColor: '#eeeeee',
      currencyCode: 'DZD',
      taxRatePercent: 1900,
      defaultLanguage: 'ar',
      setupCompletedAt: null,
      updatedAt: 1000,
    } satisfies RestaurantProfileDto);
    expect(repository.updateProfile).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(events.emitRestaurantProfileChanged).not.toHaveBeenCalled();
  });

  it('audits old/new values of the CHANGED fields only, actor attributed (D8)', async () => {
    const row = profileRow();
    repository.findProfile.mockResolvedValue(row);
    repository.updateProfile.mockImplementation(async (_id, changes) => ({ ...row, ...changes, updatedAt: 2000 }));

    await service.updateProfile('emp-owner', { taxRatePercent: 900, name: 'مطعم الجزائر' });

    expect(audit.append).toHaveBeenCalledWith({
      actorEmployeeId: 'emp-owner',
      entityType: 'restaurant_profile',
      entityId: 'profile-1',
      action: 'profile_updated',
      oldValueJson: expect.any(String),
      newValueJson: expect.any(String),
    });
    const appended = audit.append.mock.calls[0][0] as { oldValueJson: string; newValueJson: string };
    expect(JSON.parse(appended.oldValueJson)).toEqual({ taxRatePercent: 1900, name: 'Restaurant El Djazair' });
    expect(JSON.parse(appended.newValueJson)).toEqual({ taxRatePercent: 900, name: 'مطعم الجزائر' });
  });

  it('broadcasts the FULL updated profile DTO, only after the repository write (D7)', async () => {
    const row = profileRow();
    const callOrder: string[] = [];
    repository.findProfile.mockResolvedValue(row);
    repository.updateProfile.mockImplementation(async (_id, changes) => {
      callOrder.push('write');
      return { ...row, ...changes, updatedAt: 2000 };
    });
    events.emitRestaurantProfileChanged.mockImplementation(() => callOrder.push('emit'));

    const result = await service.updateProfile('emp-owner', { primaryColor: '#aabbcc' });

    expect(callOrder).toEqual(['write', 'emit']);
    expect(events.emitRestaurantProfileChanged).toHaveBeenCalledWith(result);
    expect(events.emitRestaurantProfileChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'profile-1', primaryColor: '#aabbcc', secondaryColor: '#eeeeee', taxRatePercent: 1900 }),
    );
  });

  it('logo replacement: validates+stores first, releases the old file only after the commit (D4)', async () => {
    const row = profileRow();
    const callOrder: string[] = [];
    repository.findProfile.mockResolvedValue(row);
    imageStorage.validateAndStore.mockImplementation(async () => {
      callOrder.push('store');
      return 'new-logo.png';
    });
    repository.updateProfile.mockImplementation(async (_id, changes) => {
      callOrder.push('write');
      return { ...row, ...changes, updatedAt: 2000 };
    });
    imageStorage.deleteStored.mockImplementation(async () => {
      callOrder.push('delete');
    });

    const logo = Buffer.from('fake-png-bytes');
    const result = await service.updateProfile('emp-owner', {}, logo);

    expect(imageStorage.validateAndStore).toHaveBeenCalledWith(logo);
    expect(repository.updateProfile).toHaveBeenCalledWith('profile-1', { logoPath: 'new-logo.png' });
    expect(callOrder).toEqual(['store', 'write', 'delete']);
    expect(imageStorage.deleteStored).toHaveBeenCalledWith('old-logo.png');
    expect(result.logoPath).toBe('new-logo.png');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        oldValueJson: JSON.stringify({ logoPath: 'old-logo.png' }),
        newValueJson: JSON.stringify({ logoPath: 'new-logo.png' }),
      }),
    );
  });

  it('a logo-only PATCH (no fields) is a real change, and a rejected logo leaves EVERYTHING untouched (D4)', async () => {
    const row = profileRow();
    repository.findProfile.mockResolvedValue(row);

    // Logo-only: valid change path.
    imageStorage.validateAndStore.mockResolvedValue('only-logo.webp');
    repository.updateProfile.mockImplementation(async (_id, changes) => ({ ...row, ...changes, updatedAt: 2000 }));
    await service.updateProfile('emp-owner', {}, Buffer.from('png'));
    expect(repository.updateProfile).toHaveBeenCalledWith('profile-1', { logoPath: 'only-logo.webp' });

    // Rejected upload: the row, the old file, the audit trail and the
    // broadcast all stand untouched.
    jest.clearAllMocks();
    repository.findProfile.mockResolvedValue(row);
    imageStorage.validateAndStore.mockRejectedValue(new Error('content is not a PNG, JPEG, or WebP image'));
    await expect(service.updateProfile('emp-owner', { name: 'مطعم' }, Buffer.from('svg'))).rejects.toThrow('not a PNG');
    expect(repository.updateProfile).not.toHaveBeenCalled();
    expect(imageStorage.deleteStored).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(events.emitRestaurantProfileChanged).not.toHaveBeenCalled();
  });

  it('no previous logo: nothing to release after the first successful upload', async () => {
    const row = profileRow({ logoPath: null });
    repository.findProfile.mockResolvedValue(row);
    imageStorage.validateAndStore.mockResolvedValue('first-logo.png');
    repository.updateProfile.mockImplementation(async (_id, changes) => ({ ...row, ...changes, updatedAt: 2000 }));

    await service.updateProfile('emp-owner', {}, Buffer.from('png'));

    expect(imageStorage.deleteStored).not.toHaveBeenCalled();
  });
});
