import { describe, expect, it } from 'vitest';
import {
    AUTO_BACKUP_MAX_MINUTES,
    AUTO_BACKUP_MIN_MINUTES,
    autoBackupDue,
    autoBackupMinutesToSlider,
    clampAutoBackupMinutes,
    formatAutoBackupInterval,
    loadAutoBackupConfig,
    normalizeAutoBackupConfig,
    saveAutoBackupConfig,
    sliderToAutoBackupMinutes,
} from './autoBackup';

const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => (map.has(key) ? String(map.get(key)) : null),
        setItem: (key: string, value: string) => { map.set(key, String(value)); },
    };
};

describe('autoBackup 配置', () => {
    it('间隔被夹在 20 分钟到 24 小时之间', () => {
        expect(clampAutoBackupMinutes(1)).toBe(AUTO_BACKUP_MIN_MINUTES);
        expect(clampAutoBackupMinutes(99999)).toBe(AUTO_BACKUP_MAX_MINUTES);
        expect(clampAutoBackupMinutes('90')).toBe(90);
        expect(clampAutoBackupMinutes(Number.NaN)).toBe(60);
    });

    it('缺省是关闭、纯文字、1 小时', () => {
        const config = normalizeAutoBackupConfig(null);
        expect(config.enabled).toBe(false);
        expect(config.mode).toBe('text_only');
        expect(config.intervalMinutes).toBe(60);
        expect(config.lastRunAt).toBeUndefined();
    });

    it('未知 mode 回落为纯文字，非法 lastRunAt 被丢掉', () => {
        const config = normalizeAutoBackupConfig({ enabled: true, intervalMinutes: 5, mode: 'x', lastRunAt: -1 });
        expect(config.enabled).toBe(true);
        expect(config.intervalMinutes).toBe(AUTO_BACKUP_MIN_MINUTES);
        expect(config.mode).toBe('text_only');
        expect(config.lastRunAt).toBeUndefined();
    });

    it('存取往返一致', () => {
        const storage = memoryStorage();
        const saved = saveAutoBackupConfig({ enabled: true, intervalMinutes: 120, mode: 'full', lastRunAt: 123 }, storage);
        expect(saved.intervalMinutes).toBe(120);
        expect(loadAutoBackupConfig(storage)).toEqual(saved);
    });

    it('损坏的 JSON 不会抛错', () => {
        const storage = memoryStorage();
        storage.setItem('sully_auto_backup_v1', '{oops');
        expect(loadAutoBackupConfig(storage).enabled).toBe(false);
    });
});

describe('autoBackup 到期判断', () => {
    it('关闭时永远不到期', () => {
        expect(autoBackupDue({ enabled: false, intervalMinutes: 20, mode: 'text_only' })).toBe(false);
    });

    it('没跑过就算到期', () => {
        expect(autoBackupDue({ enabled: true, intervalMinutes: 60, mode: 'text_only' }, 1_000)).toBe(true);
    });

    it('按间隔到期', () => {
        const base = 1_000_000;
        const config = { enabled: true, intervalMinutes: 30, mode: 'text_only' as const, lastRunAt: base };
        expect(autoBackupDue(config, base + 29 * 60_000)).toBe(false);
        expect(autoBackupDue(config, base + 30 * 60_000)).toBe(true);
    });
});

describe('autoBackup 滑块映射', () => {
    it('两端对应 20 分钟 / 24 小时', () => {
        expect(sliderToAutoBackupMinutes(0)).toBe(AUTO_BACKUP_MIN_MINUTES);
        expect(sliderToAutoBackupMinutes(100)).toBe(AUTO_BACKUP_MAX_MINUTES);
    });

    it('往返误差在 8% 以内（滑块只有 100 格，对数刻度允许这点抖动）', () => {
        for (const minutes of [20, 45, 120, 360, 720, 1440]) {
            const round = sliderToAutoBackupMinutes(autoBackupMinutesToSlider(minutes));
            expect(Math.abs(round - minutes) / minutes).toBeLessThan(0.08);
        }
    });

    it('文案格式', () => {
        expect(formatAutoBackupInterval(20)).toBe('20 分钟');
        expect(formatAutoBackupInterval(60)).toBe('1 小时');
        expect(formatAutoBackupInterval(120)).toBe('2 小时');
        expect(formatAutoBackupInterval(1440)).toBe('24 小时');
        expect(formatAutoBackupInterval(90)).toBe('1.5 小时');
    });
});
