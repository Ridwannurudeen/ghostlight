import type { ThemeId } from './config'
import { STORAGE_SCHEMA_VERSION, type Charade } from './types'

export const CATEGORIES = ['everyday', 'feelings', 'food', 'dcl-life', 'pop', 'awkward'] as const

export type Category = (typeof CATEGORIES)[number]

export const EMOTE_VOCABULARY = [
  'wave',
  'fistpump',
  'robot',
  'raiseHand',
  'clap',
  'money',
  'kiss',
  'shrug',
  'handsair',
  'disco',
  'dab',
  'dontsee',
  'hammer',
  'tektonik',
  'tik',
  'headexplode'
] as const

export type Emote = (typeof EMOTE_VOCABULARY)[number]

export type Phrase = {
  id: string
  text: string
  category: Category
  theme: ThemeId
  suggested: readonly [Emote, Emote, Emote]
}

type PhraseSource = Omit<Phrase, 'theme'>

const PHRASE_SOURCES = [
  {
    id: 'everyday-wake-up-late',
    text: 'Wake up late',
    category: 'everyday',
    suggested: ['dontsee', 'headexplode', 'handsair']
  },
  {
    id: 'everyday-brush-your-teeth',
    text: 'Brush your teeth',
    category: 'everyday',
    suggested: ['hammer', 'robot', 'clap']
  },
  {
    id: 'everyday-miss-the-bus',
    text: 'Miss the bus',
    category: 'everyday',
    suggested: ['wave', 'raiseHand', 'shrug']
  },
  {
    id: 'everyday-find-lost-keys',
    text: 'Find your lost keys',
    category: 'everyday',
    suggested: ['dontsee', 'raiseHand', 'fistpump']
  },
  { id: 'everyday-take-a-selfie', text: 'Take a selfie', category: 'everyday', suggested: ['tik', 'kiss', 'dab'] },
  {
    id: 'everyday-answer-the-phone',
    text: 'Answer the phone',
    category: 'everyday',
    suggested: ['raiseHand', 'wave', 'shrug']
  },
  {
    id: 'everyday-carry-groceries',
    text: 'Carry heavy groceries',
    category: 'everyday',
    suggested: ['money', 'hammer', 'handsair']
  },
  {
    id: 'everyday-open-stuck-jar',
    text: 'Open a stuck jar',
    category: 'everyday',
    suggested: ['hammer', 'fistpump', 'clap']
  },
  {
    id: 'everyday-fold-laundry',
    text: 'Fold the laundry',
    category: 'everyday',
    suggested: ['robot', 'hammer', 'shrug']
  },
  { id: 'everyday-walk-the-dog', text: 'Walk the dog', category: 'everyday', suggested: ['wave', 'tektonik', 'clap'] },
  {
    id: 'everyday-clean-a-window',
    text: 'Clean a window',
    category: 'everyday',
    suggested: ['dontsee', 'hammer', 'clap']
  },
  {
    id: 'everyday-fix-a-lightbulb',
    text: 'Fix a lightbulb',
    category: 'everyday',
    suggested: ['raiseHand', 'hammer', 'fistpump']
  },
  {
    id: 'everyday-water-the-plants',
    text: 'Water the plants',
    category: 'everyday',
    suggested: ['raiseHand', 'wave', 'clap']
  },
  {
    id: 'everyday-dance-in-elevator',
    text: 'Dance in an elevator',
    category: 'everyday',
    suggested: ['disco', 'dontsee', 'shrug']
  },
  {
    id: 'everyday-chase-a-mosquito',
    text: 'Chase a mosquito',
    category: 'everyday',
    suggested: ['clap', 'hammer', 'headexplode']
  },
  {
    id: 'everyday-dodge-the-rain',
    text: 'Dodge the rain',
    category: 'everyday',
    suggested: ['dontsee', 'tektonik', 'handsair']
  },
  {
    id: 'everyday-greet-a-neighbor',
    text: 'Greet a neighbor',
    category: 'everyday',
    suggested: ['wave', 'kiss', 'clap']
  },
  {
    id: 'everyday-choose-an-outfit',
    text: 'Choose an outfit',
    category: 'everyday',
    suggested: ['dontsee', 'disco', 'fistpump']
  },
  {
    id: 'everyday-hit-snooze',
    text: 'Hit the snooze button',
    category: 'everyday',
    suggested: ['hammer', 'dontsee', 'shrug']
  },
  {
    id: 'everyday-forget-a-password',
    text: 'Forget your password',
    category: 'everyday',
    suggested: ['headexplode', 'dontsee', 'shrug']
  },

  { id: 'feelings-fall-in-love', text: 'Fall in love', category: 'feelings', suggested: ['kiss', 'handsair', 'clap'] },
  {
    id: 'feelings-hide-embarrassment',
    text: 'Hide your embarrassment',
    category: 'feelings',
    suggested: ['dontsee', 'shrug', 'wave']
  },
  {
    id: 'feelings-celebrate-a-win',
    text: 'Celebrate a big win',
    category: 'feelings',
    suggested: ['fistpump', 'handsair', 'clap']
  },
  {
    id: 'feelings-fight-boredom',
    text: 'Fight off boredom',
    category: 'feelings',
    suggested: ['shrug', 'robot', 'disco']
  },
  {
    id: 'feelings-calm-your-nerves',
    text: 'Calm your nerves',
    category: 'feelings',
    suggested: ['dontsee', 'raiseHand', 'wave']
  },
  {
    id: 'feelings-fake-confidence',
    text: 'Fake total confidence',
    category: 'feelings',
    suggested: ['fistpump', 'dab', 'shrug']
  },
  {
    id: 'feelings-miss-someone',
    text: 'Miss someone far away',
    category: 'feelings',
    suggested: ['wave', 'kiss', 'dontsee']
  },
  {
    id: 'feelings-feel-jealous',
    text: 'Feel wildly jealous',
    category: 'feelings',
    suggested: ['dontsee', 'money', 'headexplode']
  },
  {
    id: 'feelings-burst-with-excitement',
    text: 'Burst with excitement',
    category: 'feelings',
    suggested: ['handsair', 'fistpump', 'headexplode']
  },
  {
    id: 'feelings-regret-a-decision',
    text: 'Regret that decision',
    category: 'feelings',
    suggested: ['dontsee', 'headexplode', 'shrug']
  },
  {
    id: 'feelings-suspect-a-surprise',
    text: 'Suspect a surprise',
    category: 'feelings',
    suggested: ['dontsee', 'raiseHand', 'clap']
  },
  {
    id: 'feelings-lose-your-patience',
    text: 'Lose your patience',
    category: 'feelings',
    suggested: ['hammer', 'headexplode', 'handsair']
  },
  {
    id: 'feelings-feel-proud',
    text: 'Feel extremely proud',
    category: 'feelings',
    suggested: ['fistpump', 'clap', 'dab']
  },
  {
    id: 'feelings-fear-a-spider',
    text: 'Fear a tiny spider',
    category: 'feelings',
    suggested: ['dontsee', 'handsair', 'headexplode']
  },
  {
    id: 'feelings-enjoy-the-peace',
    text: 'Enjoy perfect peace',
    category: 'feelings',
    suggested: ['kiss', 'wave', 'clap']
  },
  {
    id: 'feelings-beg-for-forgiveness',
    text: 'Beg for forgiveness',
    category: 'feelings',
    suggested: ['raiseHand', 'kiss', 'shrug']
  },
  {
    id: 'feelings-act-confused',
    text: 'Act completely confused',
    category: 'feelings',
    suggested: ['shrug', 'dontsee', 'raiseHand']
  },
  {
    id: 'feelings-get-starstruck',
    text: 'Get totally starstruck',
    category: 'feelings',
    suggested: ['dontsee', 'kiss', 'handsair']
  },
  {
    id: 'feelings-hold-in-a-laugh',
    text: 'Hold in a laugh',
    category: 'feelings',
    suggested: ['dontsee', 'shrug', 'clap']
  },
  {
    id: 'feelings-face-monday-morning',
    text: 'Face Monday morning',
    category: 'feelings',
    suggested: ['dontsee', 'headexplode', 'robot']
  },

  {
    id: 'food-burn-the-toast',
    text: 'Burn the toast',
    category: 'food',
    suggested: ['headexplode', 'dontsee', 'hammer']
  },
  {
    id: 'food-order-a-pizza',
    text: 'Order a giant pizza',
    category: 'food',
    suggested: ['raiseHand', 'money', 'clap']
  },
  {
    id: 'food-steal-some-fries',
    text: "Steal someone's fries",
    category: 'food',
    suggested: ['dontsee', 'hammer', 'fistpump']
  },
  {
    id: 'food-taste-a-lemon',
    text: 'Taste a sour lemon',
    category: 'food',
    suggested: ['kiss', 'headexplode', 'shrug']
  },
  {
    id: 'food-eat-spicy-noodles',
    text: 'Eat fiery noodles',
    category: 'food',
    suggested: ['hammer', 'headexplode', 'handsair']
  },
  { id: 'food-bake-a-cake', text: 'Bake a birthday cake', category: 'food', suggested: ['hammer', 'clap', 'kiss'] },
  { id: 'food-flip-a-pancake', text: 'Flip a pancake', category: 'food', suggested: ['hammer', 'handsair', 'clap'] },
  {
    id: 'food-share-the-popcorn',
    text: 'Share the popcorn',
    category: 'food',
    suggested: ['raiseHand', 'kiss', 'clap']
  },
  {
    id: 'food-sip-hot-coffee',
    text: 'Sip very hot coffee',
    category: 'food',
    suggested: ['kiss', 'headexplode', 'wave']
  },
  { id: 'food-peel-a-banana', text: 'Peel a banana', category: 'food', suggested: ['hammer', 'kiss', 'clap'] },
  {
    id: 'food-drop-the-ice-cream',
    text: 'Drop your ice cream',
    category: 'food',
    suggested: ['dontsee', 'headexplode', 'shrug']
  },
  {
    id: 'food-smell-fresh-cookies',
    text: 'Smell fresh cookies',
    category: 'food',
    suggested: ['kiss', 'handsair', 'clap']
  },
  { id: 'food-chop-some-onions', text: 'Chop some onions', category: 'food', suggested: ['hammer', 'dontsee', 'clap'] },
  {
    id: 'food-juggle-three-oranges',
    text: 'Juggle three oranges',
    category: 'food',
    suggested: ['handsair', 'tektonik', 'clap']
  },
  {
    id: 'food-hunt-a-midnight-snack',
    text: 'Hunt a midnight snack',
    category: 'food',
    suggested: ['dontsee', 'hammer', 'fistpump']
  },
  {
    id: 'food-toast-a-marshmallow',
    text: 'Toast a marshmallow',
    category: 'food',
    suggested: ['raiseHand', 'kiss', 'clap']
  },
  {
    id: 'food-crack-a-coconut',
    text: 'Crack a coconut',
    category: 'food',
    suggested: ['hammer', 'fistpump', 'handsair']
  },
  { id: 'food-mix-a-smoothie', text: 'Mix a fruit smoothie', category: 'food', suggested: ['robot', 'hammer', 'clap'] },
  {
    id: 'food-serve-breakfast',
    text: 'Serve breakfast in bed',
    category: 'food',
    suggested: ['raiseHand', 'kiss', 'clap']
  },
  {
    id: 'food-crave-chocolate',
    text: 'Crave all the chocolate',
    category: 'food',
    suggested: ['money', 'kiss', 'handsair']
  },

  {
    id: 'dcl-life-enter-a-portal',
    text: 'Enter a glowing portal',
    category: 'dcl-life',
    suggested: ['wave', 'handsair', 'robot']
  },
  {
    id: 'dcl-life-mint-a-wearable',
    text: 'Mint a new wearable',
    category: 'dcl-life',
    suggested: ['money', 'fistpump', 'clap']
  },
  {
    id: 'dcl-life-lose-in-a-maze',
    text: 'Lose yourself in a maze',
    category: 'dcl-life',
    suggested: ['dontsee', 'shrug', 'headexplode']
  },
  {
    id: 'dcl-life-dance-at-the-plaza',
    text: 'Dance at Genesis Plaza',
    category: 'dcl-life',
    suggested: ['disco', 'tektonik', 'clap']
  },
  {
    id: 'dcl-life-meet-your-digital-twin',
    text: 'Meet your digital twin',
    category: 'dcl-life',
    suggested: ['wave', 'robot', 'headexplode']
  },
  {
    id: 'dcl-life-flex-a-rare-wearable',
    text: 'Flex a rare wearable',
    category: 'dcl-life',
    suggested: ['money', 'dab', 'fistpump']
  },
  {
    id: 'dcl-life-vote-in-the-dao',
    text: 'Vote in the DAO',
    category: 'dcl-life',
    suggested: ['raiseHand', 'clap', 'fistpump']
  },
  {
    id: 'dcl-life-build-a-dream-house',
    text: 'Build a dream house',
    category: 'dcl-life',
    suggested: ['hammer', 'handsair', 'clap']
  },
  {
    id: 'dcl-life-teleport-to-wrong-realm',
    text: 'Teleport to the wrong realm',
    category: 'dcl-life',
    suggested: ['robot', 'dontsee', 'shrug']
  },
  {
    id: 'dcl-life-claim-a-free-wearable',
    text: 'Claim a free wearable',
    category: 'dcl-life',
    suggested: ['money', 'handsair', 'clap']
  },
  {
    id: 'dcl-life-chase-an-airdrop',
    text: 'Chase a surprise airdrop',
    category: 'dcl-life',
    suggested: ['money', 'tektonik', 'fistpump']
  },
  {
    id: 'dcl-life-tip-a-performer',
    text: 'Tip a street performer',
    category: 'dcl-life',
    suggested: ['money', 'clap', 'wave']
  },
  {
    id: 'dcl-life-explore-a-new-world',
    text: 'Explore a strange world',
    category: 'dcl-life',
    suggested: ['dontsee', 'wave', 'handsair']
  },
  {
    id: 'dcl-life-take-an-avatar-selfie',
    text: 'Take an avatar selfie',
    category: 'dcl-life',
    suggested: ['tik', 'kiss', 'dab']
  },
  {
    id: 'dcl-life-attend-metaverse-wedding',
    text: 'Attend a metaverse wedding',
    category: 'dcl-life',
    suggested: ['kiss', 'clap', 'disco']
  },
  {
    id: 'dcl-life-wave-at-an-npc',
    text: 'Wave at an NPC',
    category: 'dcl-life',
    suggested: ['wave', 'robot', 'shrug']
  },
  {
    id: 'dcl-life-crash-a-virtual-party',
    text: 'Crash a virtual party',
    category: 'dcl-life',
    suggested: ['disco', 'dontsee', 'handsair']
  },
  {
    id: 'dcl-life-find-a-secret-room',
    text: 'Find a secret room',
    category: 'dcl-life',
    suggested: ['dontsee', 'raiseHand', 'fistpump']
  },
  {
    id: 'dcl-life-trade-digital-art',
    text: 'Trade a piece of digital art',
    category: 'dcl-life',
    suggested: ['money', 'raiseHand', 'clap']
  },
  {
    id: 'dcl-life-respawn-after-falling',
    text: 'Respawn after a fall',
    category: 'dcl-life',
    suggested: ['dontsee', 'robot', 'fistpump']
  },

  {
    id: 'pop-become-a-superhero',
    text: 'Become a superhero',
    category: 'pop',
    suggested: ['handsair', 'fistpump', 'dab']
  },
  {
    id: 'pop-fight-an-invisible-villain',
    text: 'Fight an invisible villain',
    category: 'pop',
    suggested: ['hammer', 'dontsee', 'fistpump']
  },
  { id: 'pop-walk-the-red-carpet', text: 'Walk the red carpet', category: 'pop', suggested: ['wave', 'kiss', 'dab'] },
  {
    id: 'pop-win-a-talent-show',
    text: 'Win a talent show',
    category: 'pop',
    suggested: ['fistpump', 'clap', 'handsair']
  },
  {
    id: 'pop-escape-a-zombie',
    text: 'Escape a hungry zombie',
    category: 'pop',
    suggested: ['dontsee', 'tektonik', 'headexplode']
  },
  {
    id: 'pop-meet-an-alien',
    text: 'Meet a friendly alien',
    category: 'pop',
    suggested: ['wave', 'robot', 'headexplode']
  },
  {
    id: 'pop-cast-a-magic-spell',
    text: 'Cast a magic spell',
    category: 'pop',
    suggested: ['raiseHand', 'handsair', 'headexplode']
  },
  {
    id: 'pop-ride-a-space-rocket',
    text: 'Ride a space rocket',
    category: 'pop',
    suggested: ['raiseHand', 'robot', 'handsair']
  },
  {
    id: 'pop-train-like-a-ninja',
    text: 'Train like a ninja',
    category: 'pop',
    suggested: ['hammer', 'tektonik', 'dab']
  },
  {
    id: 'pop-sing-into-a-microphone',
    text: 'Sing into a microphone',
    category: 'pop',
    suggested: ['raiseHand', 'disco', 'clap']
  },
  {
    id: 'pop-direct-a-blockbuster',
    text: 'Direct a blockbuster',
    category: 'pop',
    suggested: ['raiseHand', 'clap', 'headexplode']
  },
  {
    id: 'pop-solve-a-mystery',
    text: 'Solve a spooky mystery',
    category: 'pop',
    suggested: ['dontsee', 'raiseHand', 'fistpump']
  },
  {
    id: 'pop-time-travel',
    text: 'Time travel to tomorrow',
    category: 'pop',
    suggested: ['robot', 'headexplode', 'handsair']
  },
  {
    id: 'pop-survive-a-dinosaur',
    text: 'Survive a giant dinosaur',
    category: 'pop',
    suggested: ['dontsee', 'tektonik', 'handsair']
  },
  { id: 'pop-join-a-boy-band', text: 'Join a boy band', category: 'pop', suggested: ['disco', 'wave', 'kiss'] },
  {
    id: 'pop-dodge-a-laser',
    text: 'Dodge a laser beam',
    category: 'pop',
    suggested: ['tektonik', 'dontsee', 'fistpump']
  },
  { id: 'pop-rule-a-kingdom', text: 'Rule a tiny kingdom', category: 'pop', suggested: ['raiseHand', 'money', 'clap'] },
  {
    id: 'pop-summon-a-dragon',
    text: 'Summon a sleepy dragon',
    category: 'pop',
    suggested: ['raiseHand', 'headexplode', 'clap']
  },
  { id: 'pop-ghost-party', text: 'Ghost throws a party', category: 'pop', suggested: ['handsair', 'disco', 'clap'] },
  {
    id: 'pop-reveal-secret-identity',
    text: 'Reveal your secret identity',
    category: 'pop',
    suggested: ['dontsee', 'handsair', 'fistpump']
  },

  {
    id: 'awkward-wave-at-wrong-person',
    text: 'Wave at the wrong person',
    category: 'awkward',
    suggested: ['wave', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-trip-on-stage',
    text: 'Trip while on stage',
    category: 'awkward',
    suggested: ['tektonik', 'dontsee', 'clap']
  },
  {
    id: 'awkward-forget-someones-name',
    text: "Forget someone's name",
    category: 'awkward',
    suggested: ['headexplode', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-send-wrong-message',
    text: 'Send the wrong message',
    category: 'awkward',
    suggested: ['raiseHand', 'dontsee', 'headexplode']
  },
  {
    id: 'awkward-laugh-at-bad-time',
    text: 'Laugh at the worst time',
    category: 'awkward',
    suggested: ['clap', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-get-stuck-handshaking',
    text: 'Get stuck handshaking',
    category: 'awkward',
    suggested: ['wave', 'robot', 'shrug']
  },
  {
    id: 'awkward-enter-wrong-room',
    text: 'Enter the wrong room',
    category: 'awkward',
    suggested: ['wave', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-miss-a-high-five',
    text: 'Miss a high five',
    category: 'awkward',
    suggested: ['raiseHand', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-talk-with-mouth-full',
    text: 'Talk with your mouth full',
    category: 'awkward',
    suggested: ['raiseHand', 'kiss', 'dontsee']
  },
  {
    id: 'awkward-wear-shirt-backwards',
    text: 'Wear your shirt backwards',
    category: 'awkward',
    suggested: ['dontsee', 'robot', 'shrug']
  },
  {
    id: 'awkward-dance-after-music-stops',
    text: 'Dance after the music stops',
    category: 'awkward',
    suggested: ['disco', 'dontsee', 'shrug']
  },
  {
    id: 'awkward-call-teacher-mom',
    text: 'Call your teacher Mom',
    category: 'awkward',
    suggested: ['raiseHand', 'kiss', 'dontsee']
  },
  {
    id: 'awkward-forget-why-you-entered',
    text: 'Forget why you walked in',
    category: 'awkward',
    suggested: ['dontsee', 'headexplode', 'shrug']
  },
  {
    id: 'awkward-get-caught-singing',
    text: 'Get caught singing alone',
    category: 'awkward',
    suggested: ['disco', 'dontsee', 'wave']
  },
  {
    id: 'awkward-hold-door-too-long',
    text: 'Hold the door too long',
    category: 'awkward',
    suggested: ['raiseHand', 'wave', 'shrug']
  },
  {
    id: 'awkward-sit-in-wrong-chair',
    text: 'Sit in the wrong chair',
    category: 'awkward',
    suggested: ['dontsee', 'raiseHand', 'shrug']
  },
  {
    id: 'awkward-sneeze-during-silence',
    text: 'Sneeze during total silence',
    category: 'awkward',
    suggested: ['headexplode', 'dontsee', 'wave']
  },
  {
    id: 'awkward-drop-phone-on-face',
    text: 'Drop a phone on your face',
    category: 'awkward',
    suggested: ['headexplode', 'dontsee', 'hammer']
  },
  {
    id: 'awkward-reply-to-everyone',
    text: 'Reply to everyone by mistake',
    category: 'awkward',
    suggested: ['raiseHand', 'headexplode', 'dontsee']
  },
  {
    id: 'awkward-pretend-to-know-song',
    text: 'Pretend you know the song',
    category: 'awkward',
    suggested: ['disco', 'shrug', 'clap']
  }
] as const satisfies readonly PhraseSource[]

export type PhraseId = (typeof PHRASE_SOURCES)[number]['id']

export const DECK: readonly Phrase[] = PHRASE_SOURCES.map((phrase) => ({ ...phrase, theme: phrase.category }))

const HOUSE_CHARADE_SOURCES = [
  { id: 'house-charade', phraseId: 'pop-ghost-party', emotes: ['handsair', 'disco', 'clap'] },
  {
    id: 'house-everyday-lost-keys',
    phraseId: 'everyday-find-lost-keys',
    emotes: ['dontsee', 'raiseHand', 'fistpump']
  },
  {
    id: 'house-everyday-dodge-rain',
    phraseId: 'everyday-dodge-the-rain',
    emotes: ['dontsee', 'tektonik', 'handsair']
  },
  {
    id: 'house-feelings-big-win',
    phraseId: 'feelings-celebrate-a-win',
    emotes: ['fistpump', 'handsair', 'clap']
  },
  {
    id: 'house-feelings-monday-morning',
    phraseId: 'feelings-face-monday-morning',
    emotes: ['dontsee', 'headexplode', 'robot']
  },
  { id: 'house-food-flip-pancake', phraseId: 'food-flip-a-pancake', emotes: ['hammer', 'handsair', 'clap'] },
  {
    id: 'house-food-spicy-noodles',
    phraseId: 'food-eat-spicy-noodles',
    emotes: ['hammer', 'headexplode', 'handsair']
  },
  {
    id: 'house-dcl-enter-portal',
    phraseId: 'dcl-life-enter-a-portal',
    emotes: ['wave', 'handsair', 'robot']
  },
  {
    id: 'house-dcl-wave-at-npc',
    phraseId: 'dcl-life-wave-at-an-npc',
    emotes: ['wave', 'robot', 'shrug']
  },
  {
    id: 'house-pop-secret-identity',
    phraseId: 'pop-reveal-secret-identity',
    emotes: ['dontsee', 'handsair', 'fistpump']
  },
  {
    id: 'house-awkward-wrong-person',
    phraseId: 'awkward-wave-at-wrong-person',
    emotes: ['wave', 'dontsee', 'shrug']
  }
] as const satisfies ReadonlyArray<Pick<Charade, 'id' | 'phraseId' | 'emotes'>>

export const HOUSE_CHARADES: readonly Charade[] = HOUSE_CHARADE_SOURCES.map((source) => ({
  v: STORAGE_SCHEMA_VERSION,
  id: source.id,
  author: {
    address: '0x0000000000000000000000000000000000000000',
    name: 'House',
    isGuest: true,
    bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseFemale',
    skinColor: { r: 0.72, g: 0.55, b: 0.46 },
    hairColor: { r: 0.22, g: 0.12, b: 0.08 },
    eyeColor: { r: 0.3, g: 0.48, b: 0.62 },
    wearables: []
  },
  phraseId: source.phraseId,
  emotes: [...source.emotes],
  createdAt: 0,
  guesses: { total: 0, correct: 0 },
  lastGuessAt: 0,
  isHouse: true,
  touringConsent: false
}))

export const HOUSE_CHARADE: Charade = HOUSE_CHARADES[0]
