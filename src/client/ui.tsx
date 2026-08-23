import { isMobile } from '@dcl/sdk/platform'
import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { Button, Label, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { copyToClipboard } from '~system/RestrictedActions'
import { EMOTES, playNextEmote, spike } from './spike'

const INVITE = 'Can you decode my ghost? https://decentraland.org/jump/?realm=ghostcharades.dcl.eth'

let copied = ''

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(uiComponent, { screenInset: isMobile() ? 'interactable' : 'device' })
}

const uiComponent = () => (
  <UiEntity
    uiTransform={{
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      justifyContent: 'space-between',
      alignItems: 'center'
    }}
  >
    <UiEntity
      uiTransform={{ width: 640, height: 120, margin: '12px 0 0 0', padding: 8, flexDirection: 'column' }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.55) }}
    >
      <Label
        value={`platform: ${spike.platform}   server: ${spike.serverReady ? 'ready' : 'waking'}   visits: ${spike.visits}`}
        fontSize={22}
        color={Color4.White()}
      />
      <Label
        value={`ghost: ${spike.ghostSpawned ? spike.playerName : 'waiting for player data'}   emote: ${EMOTES[spike.emoteIndex]} (#${spike.triggerCount})`}
        fontSize={22}
        color={Color4.White()}
      />
      <Label value={`cube taps: ${spike.cubeTaps}   ${copied}`} fontSize={22} color={Color4.White()} />
    </UiEntity>
    <UiEntity
      uiTransform={{ width: 640, height: 110, margin: '0 0 96px 0', flexDirection: 'row', justifyContent: 'center' }}
    >
      <Button
        value="NEXT EMOTE"
        fontSize={28}
        variant="primary"
        uiTransform={{ width: 300, height: 96, margin: '0 12px 0 0' }}
        onMouseDown={() => playNextEmote()}
      />
      <Button
        value="COPY INVITE"
        fontSize={28}
        variant="secondary"
        uiTransform={{ width: 300, height: 96 }}
        onMouseDown={() => {
          void copyToClipboard({ text: INVITE }).then(
            () => {
              copied = 'copied'
            },
            (e: unknown) => {
              copied = `copy failed: ${String(e)}`
            }
          )
        }}
      />
    </UiEntity>
  </UiEntity>
)
