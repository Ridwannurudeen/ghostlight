import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { Button, Label, UiEntity, type UiTransformProps } from '@dcl/sdk/react-ecs'
import { copyToClipboard } from '~system/RestrictedActions'
import { INVITE_URL } from '../shared/config'
import type { Emote } from '../shared/deck'
import { clientFlow, type ClientFlowState } from './flow'
import { getOpeningViewState, skipOpening, type OpeningViewState } from './opening-scene'
import { REACTION_OPTIONS, sendReaction } from './reactions'
import { getRevealViewState, type RevealViewState } from './reveal-scene'
import { getCurrentTheaterRegion } from './setup'

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

const UI_TEXTURES = {
  panel: 'assets/ui/panel.png',
  card: 'assets/ui/card.png',
  cardSelected: 'assets/ui/card_selected.png',
  marquee: 'assets/ui/marquee.png',
  ribbon: 'assets/ui/ribbon.png'
} as const

function actionButton(
  value: string,
  onMouseDown: () => void,
  disabled = false,
  variant: 'primary' | 'secondary' = 'primary'
) {
  return (
    <Button
      value={value}
      fontSize={26}
      font="monospace"
      color={{ ...COLORS.ink }}
      variant={variant}
      disabled={disabled}
      uiTransform={{ ...BUTTON }}
      onMouseDown={onMouseDown}
    />
  )
}

function canDecodeInCurrentRegion() {
  const region = getCurrentTheaterRegion()
  return region === 'house' || region === 'stage'
}

function screenShell(sentence: string, body: ReactEcs.JSX.Element, state: ClientFlowState) {
  return (
    <UiEntity
      uiTransform={PANEL}
      uiBackground={{ texture: { src: UI_TEXTURES.panel }, textureMode: 'stretch', color: COLORS.ink }}
    >
      <UiEntity
        uiTransform={{ width: '100%', minHeight: 92, padding: '14px 18px', borderRadius: 5 }}
        uiBackground={{ texture: { src: UI_TEXTURES.ribbon }, textureMode: 'stretch', color: COLORS.gold }}
      >
        <Label value={sentence} fontSize={32} font="serif" color={COLORS.ink} textAlign="middle-left" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', padding: '12px 0 0 0' }}>
        {body}
      </UiEntity>
      {state.errorCode ? (
        <Label
          value={`STATUS · ${state.errorCode.replace(/_/gu, ' ').toUpperCase()}`}
          fontSize={18}
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
    'The theater is waking up…',
    <UiEntity uiTransform={{ width: '100%', flex: 1, justifyContent: 'center', flexDirection: 'column' }}>
      <Label value="CONNECTING TO THE STAGE" fontSize={22} font="monospace" color={COLORS.muted} />
    </UiEntity>,
    state
  )
}

function foyerScreen(state: ClientFlowState) {
  const canDecode = canDecodeInCurrentRegion()
  return screenShell(
    "Tonight's ghosts are ready.",
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton(
        canDecode ? 'DECODE A GHOST' : 'WALK TO THE STAGE',
        () => clientFlow.requestNextCharade(),
        !canDecode
      )}
      {actionButton('MAKE YOUR OWN', () => clientFlow.beginAuthoring(), false, 'secondary')}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
        <UiEntity uiTransform={{ width: '49%', margin: '0 2% 0 0' }}>
          {actionButton('BOARDS', () => clientFlow.showBoards(), false, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton('INVITE', () => clientFlow.showInvite(), false, 'secondary')}
        </UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function sinceScreen(state: ClientFlowState) {
  const since = state.since
  const sentence = since
    ? `Since you left, ${since.triedYou} people tried to decode you and ${since.gotYou} got it.`
    : 'Your returning audience report is ready.'
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {since && since.rank > 0 ? (
        <Label
          value={`TODAY'S DECODER RANK · ${since.rank}`}
          fontSize={28}
          font="monospace"
          color={COLORS.gold}
          uiTransform={{ width: '100%', height: 68 }}
        />
      ) : null}
      {actionButton('ENTER THE THEATER', () => clientFlow.dismissSince())}
    </UiEntity>,
    state
  )
}

function reactions() {
  return (
    <UiEntity
      uiTransform={{
        width: 480,
        height: 128,
        positionType: 'absolute',
        position: { top: 26, right: 28 },
        padding: 10,
        flexDirection: 'row',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: COLORS.muted
      }}
      uiBackground={{ color: COLORS.surface }}
    >
      {REACTION_OPTIONS.map((reaction, index) => (
        <Button
          key={reaction.kind}
          value={reaction.label}
          fontSize={18}
          font="monospace"
          color={Color4.create(0.98, 0.17, 0.33, 1)}
          variant="secondary"
          uiTransform={{ width: '32%', minHeight: 96, height: 96, margin: index === 2 ? 0 : '0 2% 0 0' }}
          onMouseDown={() => {
            void sendReaction(reaction.kind).catch((error: unknown) => clientFlow.reportError('reaction_failed', error))
          }}
        />
      ))}
    </UiEntity>
  )
}

function decodeScreen(state: ClientFlowState) {
  const charade = state.charade
  if (!charade) return wakingScreen(state)
  const label = charade.isHouse ? 'HOUSE GHOST' : `GHOST · ${charade.authorName.toUpperCase()}`
  const waiting = state.pending.some((request) => request.kind === 'guess' || request.kind === 'roundGuess')
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {screenShell(
        `What is ${charade.authorName} saying?`,
        <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
          <Label
            value={label}
            fontSize={18}
            font="monospace"
            color={charade.isHouse ? COLORS.gold : COLORS.muted}
            textAlign="middle-left"
            uiTransform={{ width: '100%', height: 38 }}
          />
          {charade.answers.map((answer, index) =>
            actionButton(
              answer.toUpperCase(),
              () => clientFlow.guess(index),
              waiting,
              index === 0 ? 'primary' : 'secondary'
            )
          )}
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
            <UiEntity uiTransform={{ width: '49%' }}>
              {actionButton('REPLAY', () => clientFlow.replay(), waiting, 'secondary')}
            </UiEntity>
            <UiEntity uiTransform={{ width: '49%' }}>
              {actionButton('MAKE YOUR OWN', () => clientFlow.beginAuthoring(), false, 'secondary')}
            </UiEntity>
          </UiEntity>
        </UiEntity>,
        state
      )}
      {state.roundCharadeId ? reactions() : null}
    </UiEntity>
  )
}

function revealScreen(state: ClientFlowState) {
  const reveal = state.reveal
  const author = state.charade?.authorName ?? 'The ghost'
  const canDecode = canDecodeInCurrentRegion()
  const presentation = getRevealViewState()
  const sentence = presentation.verdict
    ? reveal
      ? `${author} meant “${reveal.phrase}”.`
      : 'The ghost has revealed the answer.'
    : 'The house holds its breath…'
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      <UiEntity uiTransform={{ width: '100%', height: 222, flexDirection: 'column' }}>
        {state.charade?.answers.map((answer, index) => revealAnswerCard(answer, index, presentation))}
      </UiEntity>
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
          value={presentation.verdictText || 'THE VERDICT IS COMING'}
          fontSize={25}
          font="monospace"
          color={COLORS.ink}
          textAlign="middle-center"
        />
      </UiEntity>
      {presentation.stats && reveal ? (
        <UiEntity
          uiTransform={{
            width: `${Math.round(presentation.titleProgress * 100)}%`,
            height: 48,
            padding: '4px 12px',
            overflow: 'hidden'
          }}
          uiBackground={{ texture: { src: UI_TEXTURES.ribbon }, textureMode: 'stretch', color: COLORS.gold }}
        >
          <Label
            value={`${presentation.stats.correct} OF ${presentation.stats.total} GUESSED IT · DECODER SCORE ${reveal.yourScore}`}
            fontSize={18}
            font="monospace"
            color={COLORS.ink}
            textAlign="middle-center"
          />
        </UiEntity>
      ) : null}
      {actionButton(canDecode ? 'NEXT GHOST' : 'WALK TO THE STAGE', () => clientFlow.requestNextCharade(), !canDecode)}
      {actionButton('MAKE YOUR OWN', () => clientFlow.beginAuthoring(), false, 'secondary')}
      {actionButton("TODAY'S BOARDS", () => clientFlow.showBoards(), false, 'secondary')}
    </UiEntity>,
    state
  )
}

function revealAnswerCard(answer: string, index: number, presentation: RevealViewState) {
  const isCorrect = presentation.phrase === answer
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
      <Label value={answer.toUpperCase()} fontSize={22} font="monospace" color={COLORS.ink} textAlign="middle-left" />
    </UiEntity>
  )
}

function emoteButton(emote: Emote, index: number, state: ClientFlowState) {
  const selectedIndex = state.author?.selectedEmotes.indexOf(emote) ?? -1
  const selected = selectedIndex >= 0
  return (
    <Button
      key={emote}
      value={`${selected ? `${selectedIndex + 1} · ` : ''}${emote.toUpperCase()}`}
      fontSize={22}
      font="monospace"
      color={{ ...(selected ? COLORS.ink : COLORS.bone) }}
      variant={selected ? 'primary' : 'secondary'}
      uiTransform={{ width: index === 4 ? '100%' : '49%', minHeight: 96, height: 96, margin: '5px 0' }}
      onMouseDown={() => clientFlow.selectAuthorEmote(emote)}
    />
  )
}

function authorScreen(state: ClientFlowState) {
  const author = state.author
  if (!author) return foyerScreen(state)
  const readyToPost = author.selectedEmotes.length === 3
  const posting = state.pending.some((request) => request.kind === 'post')
  return screenShell(
    `Act out “${author.phrase.text}” by choosing three emotes in order.`,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 330,
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between'
        }}
      >
        {author.offeredEmotes.map((emote, index) => emoteButton(emote, index, state))}
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '24%' }}>
          {actionButton('BACK', () => clientFlow.backFromAuthor(), posting, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '24%' }}>
          {actionButton(
            `SHUFFLE · ${author.shufflesRemaining}`,
            () => clientFlow.shuffleAuthorPhrase(),
            author.shufflesRemaining === 0 || posting,
            'secondary'
          )}
        </UiEntity>
        <UiEntity uiTransform={{ width: '24%' }}>
          {actionButton('PREVIEW', () => clientFlow.previewAuthor(), !readyToPost || posting, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '24%' }}>
          {actionButton('POST', () => clientFlow.postAuthor(), !readyToPost || posting)}
        </UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function postedScreen(state: ClientFlowState) {
  const canDecode = canDecodeInCurrentRegion()
  return screenShell(
    'Your ghost is on stage for the next stranger.',
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton('COPY INVITE', () => clientFlow.showInvite())}
      {actionButton("TODAY'S BOARDS", () => clientFlow.showBoards(), false, 'secondary')}
      {actionButton(
        canDecode ? 'DECODE ANOTHER' : 'WALK TO THE STAGE',
        () => clientFlow.requestNextCharade(),
        !canDecode,
        'secondary'
      )}
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
      <Label value={`${rank}. ${name}`} fontSize={20} color={COLORS.bone} textAlign="middle-left" />
      <Label value={value} fontSize={20} font="monospace" color={COLORS.gold} textAlign="middle-right" />
    </UiEntity>
  )
}

function boardsScreen(state: ClientFlowState) {
  const decoders = state.boards.topDecoders.slice(0, 4)
  const hardest = state.boards.hardestGhosts.slice(0, 4)
  return screenShell(
    "Today's boards count real players and exclude the house ghost.",
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column' }}>
      <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%', flexDirection: 'column' }}>
          <Label
            value="TOP DECODERS"
            fontSize={18}
            font="monospace"
            color={COLORS.muted}
            uiTransform={{ height: 40 }}
          />
          {decoders.length > 0 ? (
            decoders.map((entry, index) => boardRow(index + 1, entry.name, `${entry.correct}/${entry.total}`))
          ) : (
            <Label value="NO DECODES YET" fontSize={20} color={COLORS.muted} uiTransform={{ height: 48 }} />
          )}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%', flexDirection: 'column' }}>
          <Label
            value="HARDEST GHOSTS"
            fontSize={18}
            font="monospace"
            color={COLORS.muted}
            uiTransform={{ height: 40 }}
          />
          {hardest.length > 0 ? (
            hardest.map((entry, index) => boardRow(index + 1, entry.authorName, `${entry.correct}/${entry.total}`))
          ) : (
            <Label value="NO GUESSES YET" fontSize={20} color={COLORS.muted} uiTransform={{ height: 48 }} />
          )}
        </UiEntity>
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: '49%' }}>
          {actionButton('BACK', () => clientFlow.showFoyer(), false, 'secondary')}
        </UiEntity>
        <UiEntity uiTransform={{ width: '49%' }}>{actionButton('INVITE', () => clientFlow.showInvite())}</UiEntity>
      </UiEntity>
    </UiEntity>,
    state
  )
}

function copyInvite() {
  void copyToClipboard({ text: 'Can you decode my ghost? ' + INVITE_URL }).then(
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
      ? 'Your invitation is copied and ready to share.'
      : state.inviteStatus === 'failed'
        ? 'The invitation could not be copied on this device.'
        : 'Copy a link so a friend can decode your ghost.'
  return screenShell(
    sentence,
    <UiEntity uiTransform={{ width: '100%', flex: 1, flexDirection: 'column', justifyContent: 'center' }}>
      {actionButton('COPY INVITE', copyInvite)}
      {actionButton('BACK TO THEATER', () => clientFlow.showFoyer(), false, 'secondary')}
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
          value={opening.instruction || 'OPENING NIGHT'}
          fontSize={36}
          font="serif"
          color={COLORS.bone}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 112 }}
        />
        {actionButton('SKIP INTRO', () => skipOpening(), false, 'secondary')}
      </UiEntity>
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
  }
}

export const uiComponent = () => {
  const state = clientFlow.getState()
  const opening = getOpeningViewState()
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}
      uiBackground={{ color: Color4.create(0.02, 0.014, 0.037, 0.08) }}
    >
      {opening.active ? openingOverlay(opening) : currentScreen(state)}
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
          <Label value={state.toast.text} fontSize={24} color={COLORS.bone} textAlign="middle-center" />
        </UiEntity>
      ) : null}
    </UiEntity>
  )
}
