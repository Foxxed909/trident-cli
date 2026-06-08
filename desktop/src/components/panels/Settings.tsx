import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../../store';
import type { TridentConfig, Provider, ApprovalMode } from '../../types';

const PROVIDERS: Provider[] = ['anthropic', 'openrouter', 'vertex', 'bedrock', 'codex'];
const MODES: ApprovalMode[] = ['review', 'yolo', 'lockdown'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <div style={{
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        color: 'var(--accent)',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        marginBottom: '12px',
        paddingBottom: '6px',
        borderBottom: '1px solid var(--border)',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
      <div>
        <div style={{ fontSize: '13px', color: 'var(--text)', marginBottom: hint ? '2px' : 0 }}>{label}</div>
        {hint && <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

export default function Settings() {
  const config = useStore(s => s.config);
  const setConfig = useStore(s => s.setConfig);
  const models = useStore(s => s.models);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [local, setLocal] = useState<Partial<TridentConfig>>(config || {});

  useEffect(() => {
    if (config) setLocal(config);
  }, [config]);

  const update = (patch: Partial<TridentConfig>) => {
    setLocal(prev => ({ ...prev, ...patch }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await window.trident?.setConfig(local);
      setConfig(local as TridentConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const modelsByProvider = models.reduce((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = [];
    acc[m.provider].push(m);
    return acc;
  }, {} as Record<string, typeof models>);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px' }}>
      <div style={{ maxWidth: '580px' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)', margin: 0, letterSpacing: '0.05em' }}>
            Settings
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
            Configuration persisted to ~/.config/trident-cli/config.json
          </p>
        </div>

        <Section title="Model">
          <Field label="Provider">
            <select
              value={local.provider || 'anthropic'}
              onChange={e => update({ provider: e.target.value as Provider })}
              style={{ minWidth: '140px' }}
            >
              {PROVIDERS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Model ID" hint="Full model identifier">
            <input
              value={local.model || ''}
              onChange={e => update({ model: e.target.value })}
              placeholder="claude-sonnet-4-6"
              style={{ minWidth: '200px' }}
              list="model-list"
            />
            <datalist id="model-list">
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </datalist>
          </Field>
          <Field label="Extended Thinking" hint="claude-3-5 and claude-4+ only">
            <label className="toggle">
              <input
                type="checkbox"
                checked={local.thinking || false}
                onChange={e => update({ thinking: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </Field>
        </Section>

        <Section title="Behavior">
          <Field label="Approval Mode" hint="How TRIDENT asks before acting">
            <div style={{ display: 'flex', gap: '6px' }}>
              {MODES.map(m => {
                const colors: Record<string, string> = {
                  review: 'var(--warning)',
                  yolo: 'var(--error)',
                  lockdown: 'var(--teal)',
                };
                const active = local.mode === m;
                return (
                  <button
                    key={m}
                    onClick={() => update({ mode: m })}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${active ? colors[m] : 'var(--border)'}`,
                      background: active ? `${colors[m]}20` : 'var(--surface2)',
                      color: active ? colors[m] : 'var(--text-dim)',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: active ? 700 : 400,
                      textTransform: 'uppercase',
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Max Turns" hint="0 = unlimited">
            <input
              type="number"
              value={local.maxTurns ?? 50}
              onChange={e => update({ maxTurns: parseInt(e.target.value) || 50 })}
              min={1}
              max={200}
              style={{ width: '80px' }}
            />
          </Field>
          <Field label="Budget (USD)" hint="Cost cap, empty = unlimited">
            <input
              type="number"
              value={local.budgetUsd ?? ''}
              onChange={e => update({ budgetUsd: e.target.value ? parseFloat(e.target.value) : null })}
              placeholder="—"
              step="0.01"
              min={0}
              style={{ width: '100px' }}
            />
          </Field>
        </Section>

        <Section title="Automation">
          <Field label="Auto-test after edits" hint="Run test command after file writes">
            <label className="toggle">
              <input
                type="checkbox"
                checked={local.autoTest || false}
                onChange={e => update({ autoTest: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </Field>
          <Field label="Test command" hint="Overrides auto-detected command">
            <input
              value={local.testCommand || ''}
              onChange={e => update({ testCommand: e.target.value })}
              placeholder="npm test"
              style={{ minWidth: '180px' }}
            />
          </Field>
          <Field label="Auto-format after edits">
            <label className="toggle">
              <input
                type="checkbox"
                checked={local.autoFormat || false}
                onChange={e => update({ autoFormat: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </Field>
          <Field label="Log sessions to disk">
            <label className="toggle">
              <input
                type="checkbox"
                checked={local.logSessions !== false}
                onChange={e => update({ logSessions: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </Field>
        </Section>

        <Section title="Identity">
          <Field label="Username" hint="Shown in welcome banner">
            <input
              value={local.userName || ''}
              onChange={e => update({ userName: e.target.value })}
              placeholder="your name"
              style={{ minWidth: '180px' }}
            />
          </Field>
          <Field label="Active Profile" hint="Trained agent persona">
            <input
              value={local.profile || ''}
              onChange={e => update({ profile: e.target.value || null })}
              placeholder="e.g. Cipher"
              style={{ minWidth: '120px' }}
            />
          </Field>
        </Section>

        <Section title="System Override">
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px', fontFamily: 'var(--font-mono)' }}>
            Overrides profile output style and default formatting
          </div>
          <textarea
            value={local.systemOverride || ''}
            onChange={e => update({ systemOverride: e.target.value })}
            placeholder="Enter custom instructions..."
            rows={4}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          />
        </Section>

        {/* Save button */}
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          style={{
            width: '100%',
            padding: '10px',
            background: saved ? 'var(--success)' : 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius)',
            color: 'white',
            fontSize: '14px',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.05em',
            boxShadow: saved ? '0 0 20px rgba(16, 185, 129, 0.4)' : '0 0 20px rgba(220, 38, 38, 0.4)',
            transition: 'background 0.3s ease, box-shadow 0.3s ease',
          }}
        >
          {saving ? 'SAVING...' : saved ? '✓ SAVED' : 'SAVE SETTINGS'}
        </motion.button>
      </div>
    </div>
  );
}
