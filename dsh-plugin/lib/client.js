// KV cache: none (a settings page in the browser; it changes settings, never prompt or tool text)
// RLM mode's settings page, the browser half of rlmh-dsh (step 4c). It edits the volatile fields of the
// `rlmh-settings` profile entry (lib/settings.js) through dsh's shared settings form: values are staged until Save,
// an overridden field carries a badge and a reset, and an empty field saves as a reset. The page sits in the Plugins
// page (`plugins.item` slot) while the Host serves that entry's form. dsh supplies React and the UI primitives, so
// this file is loaded as-is (no build step), in the module format dsh's client loader expects.
window.__ModuleLoader__.load({
  id: 'rlmh-dsh',
  factory: (require) => {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    /** The profile entry whose volatile fields this page edits (cordis.patch.yml `rlmh-settings`). */
    const ENTRY = 'rlmh-settings'
    const NS = 'settings.rlmh'

    const en = {
      title: 'RLM mode',
      description: 'Choose the model and effort for RLM mode\'s sub-calls, and how much one run_code result shows.',
      subProvider: 'Sub-call provider',
      subProviderHint: 'The provider route for sub-calls, as in the model picker (for example openrouter). Leave blank to use the agent\'s own.',
      subModel: 'Sub-call model',
      subModelHint: 'The model id for sub-calls (for example ~deepseek/deepseek-flash-latest). Leave blank to use the agent\'s own model.',
      subReasoningEffort: 'Sub-call reasoning effort',
      subReasoningEffortHint: 'How much each sub-call may think. "Agent" uses the agent\'s own effort. Each level is fitted to what the sub-call model offers. Lower effort costs less output, and sub-call output is most of RLM mode\'s cost.',
      effortAgent: 'Agent',
      effortOff: 'Off',
      effortLow: 'Low',
      effortMedium: 'Medium',
      effortHigh: 'High',
      effortMax: 'Max',
      outputMaxChars: 'Result size (characters)',
      outputMaxCharsHint: 'How much of one run_code result the agent sees; the rest is cut so it reads through sub-calls. Default 8000.',
      maxSubcallsPerRun: 'Sub-calls per run_code call',
      maxSubcallsPerRunHint: 'The most sub-calls one run_code call may make. Default 200.',
      maxParallelSubcalls: 'Sub-calls at once (fallback)',
      maxParallelSubcallsHint: 'Only used when the session has no sub-call tool. Default 8.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'RLM mode\'s settings plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
    }

    const TEXT = ['subProvider', 'subModel']
    const EFFORT = 'subReasoningEffort'
    // The levels offered; '' is the agent's own. lib/subcalls.js fitEffort maps each onto the model's own levels.
    const EFFORTS = ['', 'off', 'low', 'medium', 'high', 'max']
    const NUMBERS = ['outputMaxChars', 'maxSubcallsPerRun', 'maxParallelSubcalls']

    /** The effort field: a stored value keeps its text (an older profile may hold a model's own effort id). */
    function effortField() {
      return { field: EFFORT, format: (v) => (typeof v === 'string' ? v : ''), parse: (t) => (t.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: t.trim() }) }
    }

    /** Bridges the `rlmh-settings` entry's form onto the page's staged form. */
    class RlmhCardController {
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [...TEXT.map((f) => P.settingsTextField(f)), effortField(), ...NUMBERS.map((f) => P.settingsNumberField(f))])
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        const out = { ...this.form.shell() }
        for (const f of [...TEXT, EFFORT, ...NUMBERS]) out[f] = this.form.field(f)
        return out
      }

      inject() {
        return { hooks: { rlmhCard: this.store }, ...this.form.actions() }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /** The one-liner on the Plugins page, or the settings form when the page is open. */
    function RlmhCard(props) {
      const { t } = props
      const state = props.useRlmhCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable
      const field = (name, numeric) => jsx(P.SettingsValueField, {
        id: `plugin-config-rlmh-${name}`,
        label: t(name),
        hint: t(`${name}Hint`),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric,
        disabled,
        ...state[name],
        onEdit: (text) => { props.edit(name, text) },
        onReset: () => { props.resetField(name) },
      }, name)
      // The effort is picked from fixed levels (a segmented control) instead of typed. A value saved before that is
      // none of them still shows, as one more option, until the user picks another or resets it.
      const effort = () => {
        const f = state[EFFORT]
        const label = (v) => t(`effort${v ? v[0].toUpperCase() + v.slice(1) : 'Agent'}`)
        const options = EFFORTS.map((v) => ({ value: v, label: label(v) }))
        if (f.text && !EFFORTS.includes(f.text)) options.push({ value: f.text, label: f.text })
        return jsxs('div', {
          // the same spacing, divider and type sizes as dsh's SettingsValueField (dsh 0.2.2-rc.1)
          style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0', borderTop: '1px solid rgba(127, 127, 127, 0.2)' },
          children: [
            jsxs('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
              children: [
                jsx('span', { style: { fontSize: 13, fontWeight: 500, lineHeight: 1.5 }, children: t(EFFORT) }),
                f.overridden ? jsx('button', { type: 'button', disabled, onClick: () => { props.resetField(EFFORT) }, style: { font: 'inherit', fontSize: 12, color: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', opacity: 0.7 }, children: t('reset') }) : null,
              ],
            }),
            // scrolls sideways rather than clipping when the page is narrower than the levels (phones)
            jsx('div', { style: { overflowX: 'auto', maxWidth: '100%' }, children: jsx(P.SegmentedControl, {
              id: 'plugin-config-rlmh-effort',
              label: t(EFFORT),
              value: f.text,
              options,
              disabled,
              onChange: (v) => { if (v === '') props.resetField(EFFORT); else props.edit(EFFORT, v) },
            }) }),
            jsx('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.55 }, children: t(`${EFFORT}Hint`) }),
          ],
        }, EFFORT)
      }
      return jsxs(P.SettingsForm, {
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [...TEXT.map((f) => field(f, false)), effort(), ...NUMBERS.map((f) => field(f, true))],
      })
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      // English only for now; every language dsh ships reads the same copy.
      ctx.effect(() => ctx.locale.register(NS, { en, zh: en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'rlmh-dsh: dictionaries')
      const card = new RlmhCardController(ctx.configForms.get(ENTRY))
      ctx.effect(() => () => { card.dispose() }, 'rlmh-dsh: form subscription')
      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'rlmh',
        order: 60,
        label: () => t('title'),
        locale: NS,
        inject: () => card.inject(),
      }, RlmhCard))), 'rlmh-dsh: page')
    }

    return { NS, inject, apply }
  },
})
