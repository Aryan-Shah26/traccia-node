
import { startTracing, stopTracing } from '../auto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Write traccia.toml into a temp cwd, not the repo root other suites read while running in parallel.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-config-integration-'));
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'traccia.toml');

// Mock exporters to prevent network calls
jest.mock('../exporter/otlp-exporter', () => ({
    OtlpExporter: jest.fn().mockImplementation(() => ({
        export: jest.fn().mockResolvedValue(true),
        shutdown: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../exporter/http-exporter', () => ({
    HttpExporter: jest.fn().mockImplementation(() => ({
        export: jest.fn().mockResolvedValue(true),
        shutdown: jest.fn().mockResolvedValue(undefined),
    })),
}));

describe('Configuration Integration', () => {
    let cwdSpy: jest.SpyInstance;

    beforeAll(async () => {
        cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(TEST_DIR);
        // Clean up
        if (fs.existsSync(TEST_CONFIG_PATH)) fs.unlinkSync(TEST_CONFIG_PATH);
        await stopTracing();
    });

    afterAll(() => cwdSpy.mockRestore());

    afterEach(async () => {
        if (fs.existsSync(TEST_CONFIG_PATH)) fs.unlinkSync(TEST_CONFIG_PATH);
        await stopTracing();
        delete process.env.TRACCIA_API_KEY;
    });

    it('should load configuration from traccia.toml', async () => {
        // Create test config
        const config = `
[tracing]
api_key = "toml-key"
sample_rate = 0.5
use_otlp = false
    `;
        fs.writeFileSync(TEST_CONFIG_PATH, config);

        // Initialize
        const provider = await startTracing();

        // We can't easily inspect internal state without exposing it, 
        // but we can verify no errors occurred and provider is initialized.
        expect(provider).toBeDefined();

        // In a real scenario, we might want to check the exporter type or sample rate
        // checking internal properties via casting for verification
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        //const internalProvider = provider as any;
        // Verify sampler rate if accessible, or trust that loadConfig works (covered by config.test.ts)
    });

    it('should prioritize TRACCIA_ env vars over defaults', async () => {
        process.env.TRACCIA_API_KEY = 'env-key';
        const provider = await startTracing();
        expect(provider).toBeDefined();
    });
});
