import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { Button, Label, UiEntity, type UiTransformProps } from '@dcl/sdk/react-ecs'
import { copyToClipboard } from '~system/RestrictedActions'
import { INVITE_URL, THEMES } from '../shared/config'
import type { Emote } from '../shared/deck'
import {
  LANGUAGE_LABELS,
  LANGUAGES,
  emoteLabel,
  errorLabel,
  isolatePlayerText,
  normalizePlayerName,
  phraseText,
  requirementLabel,
  seasonZeroShowLabel,
  t,
  themeLabel,
  titleLabel,
  type CopyKey,
  type Language
} from '../shared/i18n'
import { acceptedShowPolicy, showPolicyForTimestamp } from '../shared/show-policy'
import { canSendMail, canSpectatorReact, clientFlow, mailRecipients, type ClientFlowState } from './flow'
import { getPerformerBeatIndex } from './ghosts'
import { getOpeningViewState, skipOpening, type OpeningViewState } from './opening-scene'
import { REACTION_OPTIONS, sendReaction } from './reactions'
import { getRevealViewState, type RevealViewState } from './reveal-scene'
import { formatDiagnosticsBlock, formatDiagnosticsLines, getDiagnosticsSnapshot } from './diagnostics'
import { getClientSettings, updateClientSettings } from './settings'
import { isPlayerInDecodeArea } from './setup'

export const COLORS = {
  ink: Color4.create(0.035, 0.027, 0.067, 0.97),
  surface: Color4.create(0.086, 0.067, 0.133, 0.97),
  raised: Color4.create(0.16, 0.118, 0.188, 0.98),
  bone: Color4.create(0.98, 0.941, 0.827, 1),
  muted: Color4.create(0.76, 0.702, 0.655, 1),
  gold: Color4.create(0.98, 0.725, 0.267, 1),
  alert: Color4.create(0.92, 0.298, 0.337, 1),
  success: Color4.create(0.314, 0.839, 0.627, 1)
}

const PANEL = {
  width: 800,
  maxWidth: '72%',
  height: 672,
  positionType: 'absolute' as const,
  position: { top: 24, left: 28 },
  padding: 24,
  flexDirection: 'column' as const,
  borderRadius: 8,
  borderWidth: 2,
  borderColor: COLORS.gold,
  overflow: 'hidden'
} satisfies UiTransformProps

const BUTTON = { width: '100%', minHeight: 96, height: 96, margin: '6px 0' } satisfies UiTransformProps
const DECODE_BUTTON = { width: '100%', minHeight: 96, height: 96, margin: '2px 0' } satisfies UiTransformProps
const HINT_HEIGHT = 48

export const REVEAL_VERTICAL_BUDGET = {
  panelHeight: 672,
  panelPadding: 48,
  header: 92,
  bodyPadding: 12,
  content: 222,
  verdict: 84,
  actions: 108,
  hint: HINT_HEIGHT,
  status: 30
} as const

export const DECODE_VERTICAL_BUDGET = {
  panelHeight: 672,
  panelPadding: 48,
  header: 92,
  bodyPadding: 12,
  status: 28,
  performerAndBeats: 42,
  controls: 100,
  answers: 300,
  hint: HINT_HEIGHT
} as const

const UI_TEXTURES = {
  panel: 'assets/ui/panel.png',
  card: 'assets/ui/card.png',
  cardSelected: 'assets/ui/card_selected.png',
  marquee: 'assets/ui/marquee.png',
  ribbon: 'assets/ui/ribbon.png',
  stamp: 'assets/ui/stamp.png'
} as const

function accentFor(state: ClientFlowState) {
  const accent = THEMES.find((theme) => theme.id === state.theme)?.accent ?? THEMES[0].accent
  return Color4.create(accent.r, accent.g, accent.b, 1)
}

function currentShowPolicy(state: ClientFlowState) {
  return showPolicyForTimestamp(Date.now() + state.serverClockOffset)
}

function hasCurrentShowSchedule(
  state: ClientFlowState,
  policy: ReturnType<typeof showPolicyForTimestamp> = currentShowPolicy(state)
) {
  return state.ready && acceptedShowPolicy(policy, state.showKey, state.season) !== null
}

function copy(key: CopyKey, values: Record<string, string | number> = {}) {
  return t(key, getClientSettings().language, values)
}

export function shortWalletAddress(address: string) {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address
}

function playerText(name: string, uppercase = false) {
  const normalized = normalizePlayerName(name)
  return isolatePlayerText(uppercase ? normalized.toLocaleUpperCase('en-US') : normalized)
}

export function localizedAnswers(
  charade: NonNullable<ClientFlowState['charade']>,
  language: Language = getClientSettings().language
): [string, string, string] {
  if (!charade.answerIds) return charade.answers
  return charade.answerIds.map((id, index) => phraseText(id, language) ?? charade.answers[index]) as [
    string,
    string,
    string
  ]
}

export function formatPerformedAgo(
  performedAt: number,
  now: number,
  language: Language = getClientSettings().language
) {
  const elapsed = Math.max(0, now - performedAt)
  if (elapsed < 60_000) return t('time.now', language)
  if (elapsed < 3_600_000) return t('time.minutes', language, { value: Math.floor(elapsed / 60_000) })
  if (elapsed < 86_400_000) return t('time.hours', language, { value: Math.floor(elapsed / 3_600_000) })
  return t('time.days', language, { value: Math.floor(elapsed / 86_400_000) })
}

export function performerPortraitBackground(performer: { address: string; isGuest: boolean }) {
  return performer.isGuest
    ? { texture: { src: UI_TEXTURES.cardSelected }, textureMode: 'stretch' as const, color: COLORS.raised }
    : {
        avatarTexture: { userId: performer.address },
        textureMode: 'stretch' as const,
        color: COLORS.bone
      }
}

export function uiFontSize(fontSize: number, largeText = getClientSettings().largeText) {
  return largeText ? Math.round(fontSize * 1.2) : fontSize
}

function actionButton(
  value: string,
  onMouseDown: () => void,
  disabled = false,
  variant: 'primary' | 'secondary' = 'primary',
  transform: UiTransformProps = BUTTON
) {
  return (
    <Button
      value={value}
      fontSize={uiFontSize(26)}
      font="monospace"
      color={{ ...COLORS.ink }}
      variant={variant}
      disabled={disabled}
      uiTransform={{ ...transform }}
      onMouseDown={onMouseDown}
    />
  )
}

function stageInstruction() {
  return (
    <UiEntity
      uiTransform={{ ...BUTTON, borderRadius: 5, borderWidth: 2, borderColor: COLORS.gold }}
      uiBackground={{ texture: { src: UI_TEXTURES.cardSelected }, textureMode: 'stretch', color: COLORS.gold }}
    >
      <Label
        value={copy('common.walkToStage')}
        fontSize={uiFontSize(26)}
        font="monospace"
        color={COLORS.ink}
        textAlign="middle-center"
        uiTransform={{ width: '100%', minHeight: 96, height: 96 }}
      />
    </UiEntity>
  )
}

function howToPlayControl() {
  return (
    <Button
      value={copy('howToPlay.title')}
      fontSize={uiFontSize(22)}
      font="monospace"
      color={{ ...COLORS.ink }}
      variant="secondary"
      uiTransform={{
        width: 240,
        minHeight: 96,
        height: 96,
        positionType: 'absolute',
        position: { top: 24, right: 28 }
      }}
      onMouseDown={() => clientFlow.showHowToPlay()}
    />
  )
}

function canDecodeInCurrentRegion() {
  return isPlayerInDecodeArea()
}

function hintFor(state: ClientFlowState) {
  switch (state.screen) {
    case 'foyer':
      return copy(canDecodeInCurrentRegion() ? 'hint.foyerStage' : 'hint.foyerFar')
    case 'decode':
      return copy(state.retry ? 'hint.retry' : 'hint.decode')
    case 'reveal':
      return copy('hint.reveal')
    case 'author':
      if (!state.author) return null
      return copy(state.author.selectedEmotes.length < 3 ? 'author.chooseThree' : 'hint.authorReady')
    case 'posted':
      return copy('hint.posted')
    default:
      return null
  }
}

function screenShell(sentence: string, body: ReactEcs.JSX.Element, state: ClientFlowState) {
  const accent = accentFor(state)
  const hint = hintFor(state)
  return (
    <UiEntity
      uiTransform={{ ...PANEL, borderColor: accent }}
      uiBackground={{ texture: { src: UI_TEXTURES.panel }, textureMode: 'stretch', color: COLORS.ink }}
    >
      <UiEntity
        uiTransform={{ width: '100%', minHeight: 92, padding: '14px 18px', borderRadius: 5 }}
        uiBackground={{ texture: { src: UI_TEXTURES.ribbon }, textureMode: 'stretch', color: accent }}
      >
        <Label value={sentence} fontSize={uiFontSize(32)} font="serif" color={COLORS.ink} textAlign="middle-left" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', padding: '12px 0 0 0' }}>
        {body}
      </UiEntity>
      {hint ? (
        <UiEntity
          uiTransform={{ width: '100%', minHeight: HINT_HEIGHT, height: HINT_HEIGHT, padding: '6px 12px' }}
          uiBackground={{ texture: { src: UI_TEXTURES.card }, textureMode: 'stretch', color: COLORS.raised }}
        >
          <Label
            value={hint}
            fontSize={uiFontSize(18)}
            font="monospace"
            color={COLORS.bone}
            textAlign="middle-left"
            uiTransform={{ width: '100%', flex: 1 }}
          />
        </UiEntity>
      ) : null}
      {state.errorCode ? (
        <Label
          value={copy('status.label', {
            message: errorLabel(state.errorCode, getClientSettings().language).toUpperCase()
          })}
          fontSize={uiFontSize(18)}
          font="monospace"
          color={COLORS.alert}
          textAlign="middle-left"
          uiTransform={{ width: '100%', height: 30 }}
        />
      ) : null}
    </UiEntity>
  )
}

function wakingScreen(state: ClientFlowState) {
  return screenShell(
    copy('waking.title'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, justifyContent: 'center', flexDirection: 'column' }}>
      <Label value={copy('waking.connecting')} fontSize={uiFontSize(22)} font="monospace" color={COLORS.muted} />
    </UiEntity>,
    state
  )
}

function foyerScreen(state: ClientFlowState) {
  const canDecode = canDecodeInCurrentRegion()
  const policy = currentShowPolicy(state)
  const showReady = hasCurrentShowSchedule(state, policy)
  const canReact = showReady && canSpectatorReact(state) && canDecode
  const language = getClientSettings().language
  const weeklyLabel = showReady ? seasonZeroShowLabel(state.season, language) : null
  const showLabel = weeklyLabel ?? themeLabel(policy?.legacyTheme.id ?? state.theme, language)
  return screenShell(
    copy('foyer.title'),
    state.reactionMenuOpen && showReady ? (
      reactionMenu()
    ) : (
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
        <Label
          value={copy('foyer.show', { theme: showLabel.toUpperCase() })}
          fontSize={uiFontSize(20)}
          font="monospace"
          color={accentFor(state)}
          uiTransform={{ width: '100%', height: 34 }}
        />
        {state.progress?.daily.stamped ? (
          <UiEntity
            uiTransform={{ width: 88, height: 88, alignSelf: 'center' }}
            uiBackground={{ texture: { src: UI_TEXTURES.stamp }, textureMode: 'stretch' }}
          />
        ) : null}
        {canDecode
          ? actionButton(copy('foyer.decode'), () => clientFlow.requestNextCharade(), !showReady)
          : stageInstruction()}
        {actionButton(
          copy('foyer.make'),
          () => clientFlow.beginAuthoring(),
          state.playerIsGuest || !showReady,
          'secondary'
        )}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
          <UiEntity uiTransform={{ width: '49%', margin: '0 2% 0 0' }}>
            {actionButton(
              copy('foyer.mail'),
              () => clientFlow.showMail(),
              !showReady || !canSendMail(state),
              'secondary'
            )}
          </UiEntity>
          <UiEntity uiTransform={{ width: '49%' }}>
            {canReact
              ? actionButton(copy('decode.react'), () => clientFlow.toggleReactionMenu(), false, 'secondary')
              : actionButton(copy('foyer.boards'), () => clientFlow.showBoards(), false, 'secondary')}
          </UiEntity>
        </UiEntity>
      </UiEntity>
    ),
    state
  )
}

function sinceScreen(state: ClientFlowState) {
  const since = state.since
  const sentence = since
    ? copy('since.summary', {
        got: since.gotYou,
        tried: since.triedYou,
        replies: since.replies,
        mail: since.mail
      })
    : copy('since.ready')
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {since && since.rank > 0 ? (
        <Label
          value={copy('since.rank', { rank: since.rank })}
          fontSize={uiFontSize(28)}
          font="monospace"
          color={COLORS.gold}
          uiTransform={{ width: '100%', height: 68 }}
        />
      ) : null}
      {actionButton(copy('since.enter'), () => clientFlow.dismissSince())}
    </UiEntity>,
    state
  )
}

function reactionMenu() {
  return (
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      <Label value={copy('reaction.prompt')} fontSize={uiFontSize(22)} font="monospace" color={COLORS.muted} />
      {REACTION_OPTIONS.map((reaction) =>
        actionButton(
          copy(`reaction.${reaction.kind}` as CopyKey),
          () => {
            void sendReaction(reaction.kind).then(
              (sent) => {
                if (sent) clientFlow.toggleReactionMenu()
              },
              (error: unknown) => clientFlow.reportError('reaction_failed', error)
            )
          },
          false,
          'secondary'
        )
      )}
      {actionButton(copy('reaction.back'), () => clientFlow.toggleReactionMenu(), false, 'secondary')}
    </UiEntity>
  )
}

function decodeScreen(state: ClientFlowState) {
  const charade = state.charade
  if (!charade) return wakingScreen(state)
  const showReady = hasCurrentShowSchedule(state)
  const authorName = charade.isHouse ? copy('decode.houseGhost') : playerText(charade.authorName)
  const performers = charade.reply ? `${authorName} + ${playerText(charade.reply.name)}` : authorName
  const label = charade.isHouse
    ? copy('decode.houseGhost')
    : charade.recipient
      ? copy('decode.mail', { performers })
      : copy('decode.ghost', { performers })
  const answers = localizedAnswers(charade)
  const answerOptions = answers
    .map((answer, index) => ({ answer, index }))
    .filter(({ index }) => state.retry?.removedAnswerIndex !== index)
  const waiting = state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')
  const controlsDisabled = waiting || !showReady
  const question = copy(charade.reply ? 'decode.questionMany' : 'decode.questionOne', { performers })
  const sentence = state.retry
    ? copy('decode.secondChance')
    : charade.isFinale
      ? `${copy('set.finale')} · ${question}`
      : question
  const status =
    charade.setRound !== undefined &&
    charade.setSize !== undefined &&
    charade.setStreak !== undefined &&
    charade.setScore !== undefined
      ? copy('set.status', {
          round: charade.setRound,
          total: charade.setSize,
          streak: charade.setStreak,
          score: charade.setScore
        })
      : ''
  const performerBeat = state.retry?.replayBeatIndex ?? getPerformerBeatIndex()
  const spotlightLabel = state.retry
    ? copy(state.retry.spotlight ? 'spotlight.retryOn' : 'spotlight.retryOff')
    : copy('spotlight.toggle')
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      {status ? (
        <Label
          value={status}
          fontSize={uiFontSize(17)}
          font="monospace"
          color={COLORS.gold}
          textAlign="middle-left"
          uiTransform={{ width: '100%', height: 28 }}
        />
      ) : null}
      <UiEntity uiTransform={{ width: '100%', height: 42, flexDirection: 'row', justifyContent: 'space-between' }}>
        <Label
          value={label}
          fontSize={uiFontSize(16)}
          font="monospace"
          color={charade.isHouse ? COLORS.gold : COLORS.muted}
          textAlign="middle-left"
          uiTransform={{ width: '34%', height: 42 }}
        />
        <UiEntity uiTransform={{ width: '64%', height: 42, flexDirection: 'row', justifyContent: 'space-between' }}>
          {BEAT_COPY_KEYS.map((key, index) => beatChip(key, undefined, performerBeat === index))}
        </UiEntity>
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(
            spotlightLabel,
            () => clientFlow.toggleSpotlight(),
            controlsDisabled || state.retry !== null,
            state.spotlightEnabled ? 'primary' : 'secondary',
            DECODE_BUTTON
          )}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(copy('decode.replay'), () => clientFlow.replay(), controlsDisabled, 'secondary', DECODE_BUTTON)}
        </UiEntity>
      </UiEntity>
      {answerOptions.map(({ answer, index }, optionIndex) =>
        actionButton(
          answer.toUpperCase(),
          () => clientFlow.guess(index),
          controlsDisabled,
          optionIndex === 0 ? 'primary' : 'secondary',
          DECODE_BUTTON
        )
      )}
    </UiEntity>,
    state
  )
}

type CompleteSetReveal = NonNullable<ClientFlowState['reveal']> & {
  setComplete: true
  setScore: number
  setBestStreak: number
  setUnderstood: number
  setSize: number
}

function isCompleteSetReveal(reveal: ClientFlowState['reveal']): reveal is CompleteSetReveal {
  return (
    reveal?.setComplete === true &&
    reveal.setScore !== undefined &&
    reveal.setBestStreak !== undefined &&
    reveal.setUnderstood !== undefined &&
    reveal.setSize !== undefined
  )
}

function setScorecard(state: ClientFlowState, reveal: CompleteSetReveal) {
  const waiting = state.pending.some((request) => request.kind === 'nextCharade')
  const showReady = hasCurrentShowSchedule(state)
  return screenShell(
    copy('set.complete'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: '100%', height: 238, flexDirection: 'column', justifyContent: 'center' }}
        uiBackground={{ texture: { src: UI_TEXTURES.card }, textureMode: 'stretch', color: COLORS.surface }}
      >
        <Label
          value={copy('set.finalScore', { score: reveal.setScore })}
          fontSize={uiFontSize(34)}
          font="monospace"
          color={COLORS.gold}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 76 }}
        />
        <Label
          value={copy('set.bestStreak', { streak: reveal.setBestStreak })}
          fontSize={uiFontSize(24)}
          font="monospace"
          color={COLORS.bone}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 58 }}
        />
        <Label
          value={copy('set.understood', {
            understood: reveal.setUnderstood,
            total: reveal.setSize
          })}
          fontSize={uiFontSize(24)}
          font="monospace"
          color={COLORS.bone}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 58 }}
        />
      </UiEntity>
      {actionButton(copy('set.playAnother'), () => clientFlow.requestNextCharade(), waiting || !showReady)}
      {actionButton(
        copy('set.leaveGhost'),
        () => clientFlow.beginAuthoring('reveal', false, true),
        waiting || state.playerIsGuest || !showReady,
        'secondary'
      )}
    </UiEntity>,
    state
  )
}

function revealScreen(state: ClientFlowState) {
  const reveal = state.reveal
  const presentation = getRevealViewState()
  if (isCompleteSetReveal(reveal) && presentation.complete) return setScorecard(state, reveal)
  const author = state.charade?.isHouse
    ? copy('decode.houseGhost')
    : state.charade
      ? playerText(state.charade.authorName)
      : copy('decode.theGhost')
  const canDecode = canDecodeInCurrentRegion()
  const showReady = hasCurrentShowSchedule(state)
  const canReply = presentation.answerRevealed && showReady && clientFlow.canAnswerBack()
  const canReact = presentation.answerRevealed && showReady && canSpectatorReact(state) && canDecode
  const actionCount = 2 + (canReply ? 1 : 0) + (canReact ? 1 : 0)
  const actionWidth = actionCount === 4 ? '23.5%' : actionCount === 3 ? '32%' : '49%'
  const phrase = reveal ? (phraseText(reveal.phraseId, getClientSettings().language) ?? reveal.phrase) : ''
  const answers = state.charade ? localizedAnswers(state.charade) : []
  const sentence = presentation.answerRevealed
    ? reveal
      ? copy('reveal.authorMeant', { author, phrase })
      : copy('reveal.answer')
    : copy('reveal.wait')
  if (state.reactionMenuOpen && presentation.answerRevealed && showReady) {
    return screenShell(sentence, reactionMenu(), state)
  }
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      {presentation.stats && reveal ? (
        <UiEntity
          uiTransform={{ width: '100%', height: 222, flexDirection: 'column', justifyContent: 'center' }}
          uiBackground={{ texture: { src: UI_TEXTURES.card }, textureMode: 'stretch', color: COLORS.surface }}
        >
          <Label
            value={copy('reveal.guessed', {
              correct: presentation.stats.correct,
              total: presentation.stats.total
            })}
            fontSize={uiFontSize(28)}
            font="monospace"
            color={COLORS.bone}
            textAlign="middle-center"
          />
          <Label
            value={copy('reveal.progress', {
              title: titleLabel(reveal.title, getClientSettings().language).toUpperCase(),
              progress: Math.round(reveal.nextUnlock.progress * 100)
            })}
            fontSize={uiFontSize(22)}
            font="monospace"
            color={COLORS.gold}
            textAlign="middle-center"
          />
          <Label
            value={requirementLabel(reveal.nextUnlock.requirement, getClientSettings().language).toUpperCase()}
            fontSize={uiFontSize(16)}
            font="monospace"
            color={COLORS.muted}
            textAlign="middle-center"
          />
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ width: '100%', height: 222, flexDirection: 'column' }}>
          {answers.map((answer, index) => revealAnswerCard(answer, index, presentation))}
        </UiEntity>
      )}
      <UiEntity
        uiTransform={{ width: '100%', height: 72, padding: '8px 14px', margin: '6px 0' }}
        uiBackground={{
          texture: { src: presentation.verdict ? UI_TEXTURES.cardSelected : UI_TEXTURES.card },
          textureMode: 'stretch',
          color:
            presentation.verdict === 'miss'
              ? COLORS.alert
              : presentation.verdict === 'hit'
                ? COLORS.success
                : COLORS.raised
        }}
      >
        <Label
          value={presentation.verdictText || copy('reveal.verdictPending')}
          fontSize={uiFontSize(25)}
          font="monospace"
          color={COLORS.ink}
          textAlign="middle-center"
        />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: actionWidth }}>
          {canDecode
            ? actionButton(
                copy('reveal.next'),
                () => clientFlow.requestNextCharade(),
                !presentation.answerRevealed || !showReady
              )
            : stageInstruction()}
        </UiEntity>
        {canReply ? (
          <UiEntity uiTransform={{ width: actionWidth }}>
            {actionButton(copy('reveal.answerBack'), () => clientFlow.beginAnswerBack(), false, 'secondary')}
          </UiEntity>
        ) : null}
        {canReact ? (
          <UiEntity uiTransform={{ width: actionWidth }}>
            {actionButton(copy('decode.react'), () => clientFlow.toggleReactionMenu(), false, 'secondary')}
          </UiEntity>
        ) : null}
        <UiEntity uiTransform={{ width: actionWidth }}>
          {actionButton(
            copy('foyer.make'),
            () => clientFlow.beginAuthoring(),
            state.playerIsGuest || !presentation.answerRevealed || !showReady,
            'secondary'
          )}
        </UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function revealAnswerCard(answer: string, index: number, presentation: RevealViewState) {
  const isCorrect = presentation.answerRevealed && presentation.phrase === answer
  const faded = presentation.wrongAnswersFaded && !isCorrect
  const selected = presentation.selectedAnswerIndex === index
  return (
    <UiEntity
      key={`${index}-${answer}`}
      uiTransform={{ width: '100%', height: 68, margin: '3px 0', padding: '8px 14px', opacity: faded ? 0.18 : 1 }}
      uiBackground={{
        texture: { src: selected ? UI_TEXTURES.cardSelected : UI_TEXTURES.card },
        textureMode: 'stretch',
        color: isCorrect ? COLORS.success : selected ? COLORS.gold : COLORS.bone
      }}
    >
      <Label
        value={answer.toUpperCase()}
        fontSize={uiFontSize(22)}
        font="monospace"
        color={COLORS.ink}
        textAlign="middle-left"
      />
    </UiEntity>
  )
}

const BEAT_COPY_KEYS = ['beat.setup', 'beat.action', 'beat.punchline'] as const satisfies readonly CopyKey[]

function beatChip(key: (typeof BEAT_COPY_KEYS)[number], emote?: Emote, active = false) {
  return (
    <UiEntity
      key={key}
      uiTransform={{ width: '32%', height: 40, padding: '4px 6px', borderRadius: 4 }}
      uiBackground={{
        texture: { src: active ? UI_TEXTURES.cardSelected : UI_TEXTURES.card },
        textureMode: 'stretch',
        color: active ? COLORS.gold : COLORS.surface
      }}
    >
      <Label
        value={`${copy(key)}${emote ? ` · ${emoteLabel(emote, getClientSettings().language)}` : ''}`}
        fontSize={uiFontSize(emote ? 15 : 17)}
        font="monospace"
        color={active ? COLORS.ink : COLORS.bone}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}

function emoteButton(emote: Emote, disabled = false) {
  return (
    <Button
      key={emote}
      value={emoteLabel(emote, getClientSettings().language)}
      fontSize={uiFontSize(26)}
      font="monospace"
      color={{ ...COLORS.ink }}
      variant="secondary"
      disabled={disabled}
      uiTransform={{ width: '49%', minHeight: 96, height: 96, margin: '5px 0' }}
      onMouseDown={() => clientFlow.selectAuthorEmote(emote)}
    />
  )
}

function authorScreen(state: ClientFlowState) {
  const author = state.author
  if (!author) return foyerScreen(state)
  const showReady = hasCurrentShowSchedule(state)
  const readyToPost = author.selectedEmotes.length === 3
  const posting = state.pending.some((request) => request.kind === 'post')
  const replying = !!author.replyTo
  const mailing = !!author.recipient
  const phrase = phraseText(author.phrase.id, getClientSettings().language) ?? author.phrase.text
  const visibleEmotes = author.offeredEmotes.slice(author.emotePage * 4, author.emotePage * 4 + 4)
  const sentence =
    author.phase === 'phrase'
      ? replying
        ? copy('author.replyPhrase', { phrase })
        : mailing
          ? copy('author.mailPhrase', { recipient: playerText(author.recipient!.name), phrase })
          : copy('author.ownPhrase', { phrase })
      : author.phase === 'emotes'
        ? copy('author.chooseThree')
        : copy('author.ready', { phrase })
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      {author.phase === 'phrase' ? (
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
          {actionButton(copy('author.chooseEmotes'), () => clientFlow.continueAuthoring(), !showReady)}
          {!replying
            ? actionButton(
                copy('author.shuffle', { remaining: author.shufflesRemaining }),
                () => clientFlow.shuffleAuthorPhrase(),
                author.shufflesRemaining === 0 || !showReady,
                'secondary'
              )
            : null}
          {actionButton(copy('common.back'), () => clientFlow.backFromAuthor(), false, 'secondary')}
        </UiEntity>
      ) : author.phase === 'emotes' ? (
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
          <UiEntity uiTransform={{ width: '100%', height: 48, flexDirection: 'row', justifyContent: 'space-between' }}>
            {BEAT_COPY_KEYS.map((key, index) =>
              beatChip(key, author.selectedEmotes[index], index === author.selectedEmotes.length)
            )}
          </UiEntity>
          <UiEntity
            uiTransform={{
              width: '100%',
              height: 212,
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'space-between'
            }}
          >
            {visibleEmotes.map((emote) => emoteButton(emote, !showReady))}
          </UiEntity>
          {actionButton(copy('author.more'), () => clientFlow.moreAuthorEmotes(), !showReady, 'secondary')}
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
          {actionButton(
            copy('author.preview'),
            () => clientFlow.previewAuthor(),
            !readyToPost || posting || !showReady,
            'secondary'
          )}
          {actionButton(
            replying ? copy('author.sendReply') : mailing ? copy('author.sendMail') : copy('author.post'),
            () => clientFlow.postAuthor(),
            !readyToPost || posting || !showReady
          )}
          {actionButton(
            copy('author.changeEmotes'),
            () => clientFlow.reviseAuthorEmotes(),
            posting || !showReady,
            'secondary'
          )}
          {actionButton(copy('common.back'), () => clientFlow.backFromAuthor(), posting, 'secondary')}
        </UiEntity>
      )}
    </UiEntity>,
    state
  )
}

function postedScreen(state: ClientFlowState) {
  const canDecode = canDecodeInCurrentRegion()
  const showReady = hasCurrentShowSchedule(state)
  const mailRecipient = (state.boards?.playbill ?? []).find(
    (performer) => performer.address.toLowerCase() === state.postedRecipient.toLowerCase()
  )
  return screenShell(
    state.postedReplyTo
      ? copy('posted.reply', {
          performer: state.charade ? playerText(state.charade.authorName) : copy('posted.originalPerformer')
        })
      : state.postedRecipient
        ? copy('posted.mail', {
            recipient: mailRecipient ? playerText(mailRecipient.name) : copy('posted.mailRecipient')
          })
        : copy('posted.ghost'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton(copy('posted.copyInvite'), () => copyInvite(true))}
      {actionButton(copy('posted.boards'), () => clientFlow.showBoards(), false, 'secondary')}
      {canDecode
        ? actionButton(copy('posted.decodeAnother'), () => clientFlow.requestNextCharade(), !showReady, 'secondary')
        : stageInstruction()}
    </UiEntity>,
    state
  )
}

function mailScreen(state: ClientFlowState) {
  const recipients = mailRecipients(state).slice(0, 4)
  const selected = state.mailRecipient
  const showReady = hasCurrentShowSchedule(state)
  return screenShell(
    copy(selected ? 'mail.confirm' : 'mail.choose'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {selected ? (
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
          <UiEntity
            uiTransform={{ width: 112, height: 112, alignSelf: 'center', borderRadius: 56, overflow: 'hidden' }}
            uiBackground={performerPortraitBackground({ address: selected.address, isGuest: false })}
          />
          <Label
            value={playerText(selected.name, true)}
            fontSize={uiFontSize(28)}
            color={COLORS.bone}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 46 }}
          />
          <Label
            value={shortWalletAddress(selected.address)}
            fontSize={uiFontSize(22)}
            font="monospace"
            color={COLORS.gold}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 42 }}
          />
          {actionButton(copy('mail.confirmAction'), () => clientFlow.beginGhostMail(), !showReady)}
          {actionButton(copy('mail.chooseDifferent'), () => clientFlow.clearGhostMailRecipient(), false, 'secondary')}
        </UiEntity>
      ) : (
        recipients.map((recipient) => (
          <UiEntity
            key={recipient.address}
            uiTransform={{ width: '100%', height: 96, margin: '6px 0', flexDirection: 'row' }}
          >
            <UiEntity
              uiTransform={{ width: 88, height: 88, margin: '4px 10px 4px 0', borderRadius: 44, overflow: 'hidden' }}
              uiBackground={performerPortraitBackground(recipient)}
            />
            <UiEntity uiTransform={{ flex: 1 }}>
              {actionButton(
                `${playerText(recipient.name, true)} · ${shortWalletAddress(recipient.address)}`,
                () => clientFlow.selectGhostMailRecipient(recipient.address),
                !showReady,
                'secondary'
              )}
            </UiEntity>
          </UiEntity>
        ))
      )}
      {!selected ? actionButton(copy('common.back'), () => clientFlow.showFoyer(), false, 'secondary') : null}
    </UiEntity>,
    state
  )
}

const HOW_TO_PLAY_STEPS = [
  'howToPlay.walk',
  'howToPlay.watch',
  'howToPlay.guess',
  'howToPlay.leave',
  'howToPlay.realPlayers'
] as const satisfies readonly CopyKey[]

function howToPlayScreen(state: ClientFlowState) {
  return screenShell(
    copy('howToPlay.title'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
        {HOW_TO_PLAY_STEPS.map((key) => (
          <UiEntity
            key={key}
            uiTransform={{ width: '100%', flex: 1, minHeight: 64, padding: '8px 14px', margin: '3px 0' }}
            uiBackground={{ texture: { src: UI_TEXTURES.card }, textureMode: 'stretch', color: COLORS.surface }}
          >
            <Label
              value={copy(key)}
              fontSize={uiFontSize(22)}
              font="monospace"
              color={COLORS.bone}
              textAlign="middle-left"
            />
          </UiEntity>
        ))}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(copy('common.settings'), () => clientFlow.showSettings(), false, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(copy('common.back'), () => clientFlow.showFoyer(), false, 'secondary')}
        </UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function settingsScreen(state: ClientFlowState) {
  const settings = getClientSettings()
  if (settings.diagnosticsEnabled) {
    const snapshot = getDiagnosticsSnapshot(settings.language, {
      ready: state.ready,
      instanceId: state.instanceId
    })
    const lines = ['GHOSTLIGHT_DIAGNOSTICS v1', ...formatDiagnosticsLines(snapshot)]
    return screenShell(
      copy('diagnostics.title'),
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', padding: '8px 4px' }}>
          {lines.map((line) => (
            <Label
              value={line}
              fontSize={uiFontSize(16)}
              font="monospace"
              color={COLORS.bone}
              textAlign="middle-left"
              uiTransform={{ width: '100%', minHeight: 32 }}
            />
          ))}
        </UiEntity>
        {actionButton(copy('diagnostics.copy'), () => {
          void copyToClipboard({ text: formatDiagnosticsBlock(snapshot) }).catch((error: unknown) => {
            console.error('Ghostlight diagnostics copy failed', error)
          })
        })}
        {actionButton(
          copy('diagnostics.disable'),
          () => updateClientSettings({ diagnosticsEnabled: false }),
          false,
          'secondary'
        )}
        {actionButton(copy('common.back'), () => clientFlow.showFoyer(), false, 'secondary')}
      </UiEntity>,
      state
    )
  }

  const soundValue = !settings.soundEnabled
    ? copy('common.off')
    : settings.soundVolume === 0.5
      ? copy('common.quiet')
      : copy('common.full')
  const accessibilityValue = settings.reducedMotion
    ? settings.largeText
      ? copy('settings.accessibilityBoth')
      : copy('settings.accessibilityReduced')
    : settings.largeText
      ? copy('settings.accessibilityLarge')
      : copy('common.off')
  return screenShell(
    copy('settings.title'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton(copy('settings.sound', { value: soundValue }), () => {
        if (!settings.soundEnabled) {
          updateClientSettings({ soundEnabled: true, soundVolume: 0.5 })
        } else if (settings.soundVolume === 0.5) {
          updateClientSettings({ soundVolume: 1 })
        } else {
          updateClientSettings({ soundEnabled: false })
        }
      })}
      {actionButton(
        copy('settings.language', { language: LANGUAGE_LABELS[settings.language] }),
        () => {
          const index = LANGUAGES.indexOf(settings.language)
          updateClientSettings({ language: LANGUAGES[(index + 1) % LANGUAGES.length] })
        },
        false,
        'secondary'
      )}
      {actionButton(
        copy('settings.accessibility', { value: accessibilityValue }),
        () => {
          if (!settings.reducedMotion && !settings.largeText) {
            updateClientSettings({ reducedMotion: true })
          } else if (settings.reducedMotion && !settings.largeText) {
            updateClientSettings({ reducedMotion: false, largeText: true })
          } else if (!settings.reducedMotion && settings.largeText) {
            updateClientSettings({ reducedMotion: true })
          } else {
            updateClientSettings({ reducedMotion: false, largeText: false })
          }
        },
        false,
        'secondary'
      )}
      {actionButton(
        copy('settings.diagnostics', { value: copy('common.off') }),
        () => updateClientSettings({ diagnosticsEnabled: true }),
        false,
        'secondary'
      )}
      {actionButton(copy('howToPlay.title'), () => clientFlow.showHowToPlay(), false, 'secondary')}
    </UiEntity>,
    state
  )
}

function boardRow(rank: number, name: string, value: string) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 48,
        padding: '4px 8px',
        flexDirection: 'row',
        justifyContent: 'space-between'
      }}
      uiBackground={{ color: rank % 2 === 0 ? COLORS.raised : COLORS.surface }}
    >
      <Label
        value={`${rank}. ${playerText(name)}`}
        fontSize={uiFontSize(20)}
        color={COLORS.bone}
        textAlign="middle-left"
      />
      <Label value={value} fontSize={uiFontSize(20)} font="monospace" color={COLORS.gold} textAlign="middle-right" />
    </UiEntity>
  )
}

function playbillCard(performer: ClientFlowState['boards']['playbill'][number], now: number, index: number) {
  return (
    <UiEntity
      key={`${performer.address}-${performer.performedAt}-${index}`}
      uiTransform={{ width: '49%', height: 64, padding: 6, margin: '2px 0', flexDirection: 'row' }}
      uiBackground={{ texture: { src: UI_TEXTURES.card }, textureMode: 'stretch', color: COLORS.surface }}
    >
      <UiEntity
        uiTransform={{ width: 52, height: 52, margin: '0 8px 0 0', borderRadius: 26, overflow: 'hidden' }}
        uiBackground={performerPortraitBackground(performer)}
      />
      <UiEntity uiTransform={{ flex: 1, height: 52, flexDirection: 'column' }}>
        <Label
          value={playerText(performer.name, true)}
          fontSize={uiFontSize(17)}
          color={COLORS.bone}
          textAlign="top-left"
          uiTransform={{ width: '100%', height: 24 }}
        />
        <Label
          value={`${performer.title ? titleLabel(performer.title, getClientSettings().language) : copy('boards.newGhost')} · ${formatPerformedAgo(performer.performedAt, now)}`}
          fontSize={uiFontSize(13)}
          font="monospace"
          color={COLORS.muted}
          textAlign="bottom-left"
          uiTransform={{ width: '100%', height: 24 }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function boardsScreen(state: ClientFlowState) {
  const decoders = state.boards.topDecoders.slice(0, 3)
  const crowdPleasers = state.boards.hardestGhosts.slice(0, 3)
  const playbill = (state.boards.playbill ?? []).slice(0, 6)
  const alignedNow = Date.now() + state.serverClockOffset
  return screenShell(
    copy('boards.title'),
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      <Label value={copy('boards.playbill')} fontSize={uiFontSize(18)} font="monospace" color={COLORS.muted} />
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 204,
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between'
        }}
      >
        {playbill.map((performer, index) => playbillCard(performer, alignedNow, index))}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%', flexDirection: 'column' }}>
          <Label
            value={copy('boards.topDecoders')}
            fontSize={uiFontSize(18)}
            font="monospace"
            color={COLORS.muted}
            uiTransform={{ height: 40 }}
          />
          {decoders.length > 0 ? (
            decoders.map((entry, index) => boardRow(index + 1, entry.name, `${entry.correct}/${entry.total}`))
          ) : (
            <Label
              value={copy('boards.noDecodes')}
              fontSize={uiFontSize(20)}
              color={COLORS.muted}
              uiTransform={{ height: 48 }}
            />
          )}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%', flexDirection: 'column' }}>
          <Label
            value={copy('boards.crowdPleaser')}
            fontSize={uiFontSize(18)}
            font="monospace"
            color={COLORS.muted}
            uiTransform={{ height: 40 }}
          />
          {crowdPleasers.length > 0 ? (
            crowdPleasers.map((entry, index) =>
              boardRow(index + 1, entry.authorName, `${entry.correct}/${entry.total}`)
            )
          ) : (
            <Label
              value={copy('boards.noCrowdPleaser')}
              fontSize={uiFontSize(20)}
              color={COLORS.muted}
              uiTransform={{ height: 48 }}
            />
          )}
        </UiEntity>
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(copy('common.back'), () => clientFlow.showFoyer(), false, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton(copy('boards.invite'), () => clientFlow.showInvite())}
        </UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function copyInvite(showInvite = false) {
  if (showInvite) clientFlow.showInvite()
  void copyToClipboard({ text: copy('invite.message', { url: INVITE_URL }) }).then(
    () => clientFlow.setInviteStatus('copied'),
    (error: unknown) => {
      clientFlow.setInviteStatus('failed')
      clientFlow.reportError('copy_failed', error)
    }
  )
}

function inviteScreen(state: ClientFlowState) {
  const sentence =
    state.inviteStatus === 'copied'
      ? copy('invite.copied')
      : state.inviteStatus === 'failed'
        ? copy('invite.failed')
        : copy('invite.ready')
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton(copy('invite.copy'), copyInvite)}
      {actionButton(copy('invite.back'), () => clientFlow.showFoyer(), false, 'secondary')}
    </UiEntity>,
    state
  )
}

function openingOverlay(opening: OpeningViewState) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: Color4.create(0.02, 0.014, 0.037, 0.72) }}
    >
      <UiEntity
        uiTransform={{ width: 780, maxWidth: '72%', height: 270, padding: 30, flexDirection: 'column' }}
        uiBackground={{ texture: { src: UI_TEXTURES.marquee }, textureMode: 'stretch', color: COLORS.ink }}
      >
        <Label
          value={opening.instruction || copy('opening.night')}
          fontSize={uiFontSize(36)}
          font="serif"
          color={COLORS.bone}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 112 }}
        />
        {actionButton(copy('opening.skip'), () => skipOpening(), false, 'secondary')}
      </UiEntity>
    </UiEntity>
  )
}

function noticeOverlay(state: ClientFlowState) {
  const notice = state.notices?.[0]
  if (!notice) return null
  if (state.screen === 'reveal' && !getRevealViewState().stats) return null
  const title =
    notice.kind === 'stamp'
      ? copy('notice.stampTitle')
      : copy('notice.titleUnlocked', {
          title: titleLabel(notice.title, getClientSettings().language).toUpperCase()
        })
  const noticeCopy =
    notice.kind === 'stamp'
      ? t('notice.stampCopy', getClientSettings().language)
      : t('notice.titleCopy', getClientSettings().language)
  return (
    <UiEntity
      uiTransform={{
        width: 560,
        maxWidth: '70%',
        height: 250,
        positionType: 'absolute',
        position: { top: 190, left: '32%' },
        padding: 18,
        flexDirection: 'column',
        borderWidth: 2,
        borderColor: accentFor(state)
      }}
      uiBackground={{ texture: { src: UI_TEXTURES.cardSelected }, textureMode: 'stretch', color: COLORS.ink }}
    >
      {notice.kind === 'stamp' ? (
        <UiEntity
          uiTransform={{ width: 72, height: 72, alignSelf: 'center' }}
          uiBackground={{ texture: { src: UI_TEXTURES.stamp }, textureMode: 'stretch' }}
        />
      ) : null}
      <Label value={title} fontSize={uiFontSize(24)} font="monospace" color={COLORS.gold} textAlign="middle-center" />
      <Label value={noticeCopy} fontSize={uiFontSize(18)} color={COLORS.bone} textAlign="middle-center" />
      {actionButton(
        t('notice.dismiss', getClientSettings().language),
        () => clientFlow.dismissNotice(notice.id),
        false,
        'secondary'
      )}
    </UiEntity>
  )
}

function reactionStamp(state: ClientFlowState) {
  const event = state.reactionEvent
  if (!event || Date.now() - event.shownAt >= 3_000) return null
  return (
    <UiEntity
      uiTransform={{
        width: 300,
        height: 64,
        positionType: 'absolute',
        position: { top: 110, right: 28 },
        padding: '8px 14px',
        borderRadius: 5,
        borderWidth: 2,
        borderColor: COLORS.gold
      }}
      uiBackground={{ texture: { src: UI_TEXTURES.stamp }, textureMode: 'stretch', color: COLORS.surface }}
    >
      <Label
        value={copy(`reaction.${event.kind}` as CopyKey)}
        fontSize={uiFontSize(22)}
        font="monospace"
        color={COLORS.bone}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}

function currentScreen(state: ClientFlowState) {
  switch (state.screen) {
    case 'waking':
      return wakingScreen(state)
    case 'foyer':
      return foyerScreen(state)
    case 'since':
      return sinceScreen(state)
    case 'decode':
      return decodeScreen(state)
    case 'reveal':
      return revealScreen(state)
    case 'author':
      return authorScreen(state)
    case 'posted':
      return postedScreen(state)
    case 'boards':
      return boardsScreen(state)
    case 'invite':
      return inviteScreen(state)
    case 'mail':
      return mailScreen(state)
    case 'howToPlay':
      return howToPlayScreen(state)
    case 'settings':
      return settingsScreen(state)
  }
}

export const uiComponent = () => {
  const state = clientFlow.getState()
  const opening = getOpeningViewState()
  const notice = opening.active ? null : noticeOverlay(state)
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}
      uiBackground={{ color: Color4.create(0.02, 0.014, 0.037, 0.08) }}
    >
      {opening.active ? openingOverlay(opening) : (notice ?? currentScreen(state))}
      {!opening.active && !notice && state.screen === 'foyer' ? howToPlayControl() : null}
      {!opening.active ? reactionStamp(state) : null}
      {!opening.active && state.toast ? (
        <UiEntity
          uiTransform={{
            width: 520,
            height: 72,
            positionType: 'absolute',
            position: { top: 166, right: 28 },
            padding: '10px 16px',
            borderRadius: 5,
            borderWidth: 2,
            borderColor: COLORS.gold
          }}
          uiBackground={{ color: COLORS.surface }}
        >
          <Label
            value={copy('round.winner', { name: playerText(state.toast.winnerName) })}
            fontSize={uiFontSize(24)}
            color={COLORS.bone}
            textAlign="middle-center"
          />
        </UiEntity>
      ) : null}
    </UiEntity>
  )
}
