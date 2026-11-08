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
      subReasoningEffortHint: 'An effort the sub-call model offers, such as low, medium or high. Leave blank to use the agent\'s effort. Lower effort costs less output.',
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

    const TEXT = ['subProvider', 'subModel', 'subReasoningEffort']
    const NUMBERS = ['outputMaxChars', 'maxSubcallsPerRun', 'maxParallelSubcalls']

    /** Bridges the `rlmh-settings` entry's form onto the page's staged form. */
    class RlmhCardController {
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [...TEXT.map((f) => P.settingsTextField(f)), ...NUMBERS.map((f) => P.settingsNumberField(f))])
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        const out = { ...this.form.shell() }
        for (const f of [...TEXT, ...NUMBERS]) out[f] = this.form.field(f)
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
      return jsxs(P.SettingsForm, {
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [...TEXT.map((f) => field(f, false)), ...NUMBERS.map((f) => field(f, true))],
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
