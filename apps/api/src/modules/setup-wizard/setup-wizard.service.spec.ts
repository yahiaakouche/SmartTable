import { SetupWizardService } from './setup-wizard.service';
import { SetupWizardRepository, SetupCompletionResult } from './setup-wizard.repository';
import { SetupAlreadyCompletedException } from '../../common/exceptions/domain.exception';
import { CompleteSetupDto } from './dto/complete-setup.dto';

/**
 * Unit tests for the setup wizard service (Step 3.11, Engineering
 * Standards §10): the D3 status semantics, the orchestration ordering
 * (hash credentials → store logo → atomic transaction → audit), the FR15
 * defaults, the B2(a) hall/label generation, the D9 audit row (null
 * actor, no credential material), and the D8 orphan-logo cleanup on any
 * transaction failure.
 */
describe('SetupWizardService', () => {
  let service: SetupWizardService;
  let repository: jest.Mocked<SetupWizardRepository>;
  let configService: { findProfileOrNull: jest.Mock };
  let authService: { hashCredentials: jest.Mock };
  let imageStorage: { validateAndStore: jest.Mock; deleteStored: jest.Mock };
  let audit: { append: jest.Mock };

  const dto = (overrides: Partial<CompleteSetupDto> = {}): CompleteSetupDto => ({
    name: 'Restaurant El Djazair',
    primaryColor: '#112233',
    secondaryColor: '#ddeeff',
    tableCount: 3,
    ownerName: 'Karim',
    ownerPassword: 'sup3rsecret',
    ownerPin: '1234',
    ...overrides,
  });

  const result = (): SetupCompletionResult => ({
    profile: {
      id: 'profile-1',
      name: 'Restaurant El Djazair',
      logoPath: 'logo-file.png',
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      currencyCode: 'DZD',
      taxRatePercent: 0,
      defaultLanguage: 'ar',
      setupCompletedAt: 5000,
      updatedAt: 5000,
    },
    hall: { id: 'hall-1', name: 'Main Hall', sortOrder: 0, isActive: true },
    tables: [
      { id: 't1', hallId: 'hall-1', label: 'Table 1', qrToken: 'tok-1', status: 'available', isActive: true, updatedAt: 5000 },
      { id: 't2', hallId: 'hall-1', label: 'Table 2', qrToken: 'tok-2', status: 'available', isActive: true, updatedAt: 5000 },
    ],
    owner: {
      id: 'emp-owner',
      name: 'Karim',
      role: 'owner',
      email: null,
      passwordHash: 'pw-hash',
      pinHash: 'pin-hash',
      isActive: true,
      lastLoginAt: null,
      createdAt: 5000,
    },
  });

  beforeEach(() => {
    repository = { completeTransaction: jest.fn() };
    configService = { findProfileOrNull: jest.fn() };
    authService = {
      hashCredentials: jest.fn().mockResolvedValue({ passwordHash: 'pw-hash', pinHash: 'pin-hash' }),
    };
    imageStorage = {
      validateAndStore: jest.fn(),
      deleteStored: jest.fn().mockResolvedValue(undefined),
    };
    audit = { append: jest.fn().mockResolvedValue(undefined) };

    service = new SetupWizardService(
      repository,
      configService as never,
      authService as never,
      imageStorage as never,
      audit as never,
    );
  });

  it('status: no profile row → not completed (fresh installation)', async () => {
    configService.findProfileOrNull.mockResolvedValue(null);
    await expect(service.getStatus()).resolves.toEqual({ completed: false, completedAt: null });
  });

  it('status: setupCompletedAt is the semantic source (D3)', async () => {
    configService.findProfileOrNull.mockResolvedValue({ setupCompletedAt: null });
    await expect(service.getStatus()).resolves.toEqual({ completed: false, completedAt: null });

    configService.findProfileOrNull.mockResolvedValue({ setupCompletedAt: 5000 });
    await expect(service.getStatus()).resolves.toEqual({ completed: true, completedAt: 5000 });
  });

  it('happy path: hashes credentials first, stores the logo, then one atomic write with FR15 defaults and B2(a) rows', async () => {
    const order: string[] = [];
    authService.hashCredentials.mockImplementation(() => {
      order.push('hash');
      return Promise.resolve({ passwordHash: 'pw-hash', pinHash: 'pin-hash' });
    });
    imageStorage.validateAndStore.mockImplementation(() => {
      order.push('store-logo');
      return Promise.resolve('logo-file.png');
    });
    repository.completeTransaction.mockImplementation(() => {
      order.push('tx');
      return Promise.resolve(result());
    });

    const response = await service.completeSetup(dto(), Buffer.from('png-bytes'));

    expect(order).toEqual(['hash', 'store-logo', 'tx']);
    expect(authService.hashCredentials).toHaveBeenCalledWith('sup3rsecret', '1234');
    expect(imageStorage.validateAndStore).toHaveBeenCalledWith(Buffer.from('png-bytes'));

    const write = repository.completeTransaction.mock.calls[0]![0];
    expect(write.profile).toMatchObject({
      name: 'Restaurant El Djazair',
      logoPath: 'logo-file.png',
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      currencyCode: 'DZD', // FR15 default
      defaultLanguage: 'ar', // FR15 default
    });
    expect(write.profile.setupCompletedAt).toEqual(expect.any(Number));
    expect(write.hall).toEqual({ name: 'Main Hall', sortOrder: 0 });
    expect(write.tables).toEqual([{ label: 'Table 1' }, { label: 'Table 2' }, { label: 'Table 3' }]);
    expect(write.owner).toEqual({ name: 'Karim', passwordHash: 'pw-hash', pinHash: 'pin-hash' });

    expect(response.profile).toMatchObject({ id: 'profile-1', taxRatePercent: 0, setupCompletedAt: 5000 });
    expect(response.owner).toMatchObject({ id: 'emp-owner', role: 'owner', invitationStatus: null });
    expect(response.owner).not.toHaveProperty('passwordHash');
    expect(response.owner).not.toHaveProperty('pinHash');
    expect(response.hall).toMatchObject({ id: 'hall-1', name: 'Main Hall' });
    expect(response.tables).toHaveLength(2);
    expect(response.tables[0]).toMatchObject({ label: 'Table 1', qrToken: 'tok-1', status: 'available' });
  });

  it('explicit currency/language override the FR15 defaults (D6)', async () => {
    repository.completeTransaction.mockResolvedValue(result());
    await service.completeSetup(dto({ currencyCode: 'EUR', defaultLanguage: 'fr' }));
    const write = repository.completeTransaction.mock.calls[0]![0];
    expect(write.profile).toMatchObject({ currencyCode: 'EUR', defaultLanguage: 'fr' });
  });

  it('no logo: the storage pipeline is skipped entirely and logoPath stays null', async () => {
    repository.completeTransaction.mockResolvedValue(result());
    await service.completeSetup(dto());
    expect(imageStorage.validateAndStore).not.toHaveBeenCalled();
    expect(repository.completeTransaction.mock.calls[0]![0].profile.logoPath).toBeNull();
    expect(imageStorage.deleteStored).not.toHaveBeenCalled();
  });

  it('audits the bootstrap with a null actor and NO credential material (D9)', async () => {
    repository.completeTransaction.mockResolvedValue(result());
    await service.completeSetup(dto(), undefined);

    expect(audit.append).toHaveBeenCalledTimes(1);
    const entry = audit.append.mock.calls[0]![0];
    expect(entry).toMatchObject({
      actorEmployeeId: null,
      entityType: 'setup',
      entityId: 'profile-1',
      action: 'setup_completed',
    });
    const payload = JSON.parse(entry.newValueJson);
    expect(payload).toEqual({
      profileId: 'profile-1',
      hallId: 'hall-1',
      tableCount: 2,
      ownerEmployeeId: 'emp-owner',
    });
    expect(entry.newValueJson).not.toMatch(/sup3rsecret|1234|pw-hash|pin-hash/);
  });

  it('transaction failure (e.g. the B1(a) guard) releases the stored logo and skips the audit (D8)', async () => {
    imageStorage.validateAndStore.mockResolvedValue('logo-file.png');
    repository.completeTransaction.mockRejectedValue(new SetupAlreadyCompletedException());

    await expect(service.completeSetup(dto(), Buffer.from('png-bytes'))).rejects.toBeInstanceOf(
      SetupAlreadyCompletedException,
    );
    expect(imageStorage.deleteStored).toHaveBeenCalledWith('logo-file.png');
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('a failing logo cleanup never masks the original transaction error', async () => {
    imageStorage.validateAndStore.mockResolvedValue('logo-file.png');
    imageStorage.deleteStored.mockRejectedValue(new Error('disk busy'));
    repository.completeTransaction.mockRejectedValue(new SetupAlreadyCompletedException());

    await expect(service.completeSetup(dto(), Buffer.from('png-bytes'))).rejects.toBeInstanceOf(
      SetupAlreadyCompletedException,
    );
  });

  it('logo rejection aborts before any write: no transaction, no audit, nothing to release', async () => {
    imageStorage.validateAndStore.mockRejectedValue(new Error('INVALID_FILE_UPLOAD'));

    await expect(service.completeSetup(dto(), Buffer.from('svg-bytes'))).rejects.toThrow('INVALID_FILE_UPLOAD');
    expect(repository.completeTransaction).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(imageStorage.deleteStored).not.toHaveBeenCalled();
  });

  it('transaction failure without a logo never touches the storage cleanup', async () => {
    repository.completeTransaction.mockRejectedValue(new Error('disk full'));
    await expect(service.completeSetup(dto())).rejects.toThrow('disk full');
    expect(imageStorage.deleteStored).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});
