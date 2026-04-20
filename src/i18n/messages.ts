export type Locale = 'zh' | 'en';

export const STORAGE_THEME = 'mofang2-theme';
export const STORAGE_LOCALE = 'mofang2-locale';

/** 扁平 key，便于 `t('foo.bar')` */
export const messages: Record<Locale, Record<string, string>> = {
  zh: {
    'app.title': 'Cube',
    'app.aria.cube3d': '三阶魔方三维视图，拖拽旋转视角，点击贴纸换色',
    'app.aria.io': '面串输入与求解步骤',
    'app.aria.toolbar': '操作',
    'app.aria.side': '选色与约束',
    'app.aria.chrome': '显示与语言',

    'splash.aria': '欢迎',
    'splash.main1': '随心定义魔方配色',
    'splash.pcMain2': '每一次填充，我们都实时确保它，真实可解',
    'splash.mMain2': '每一次填充',
    'splash.mMain3': '我们都实时确保它',
    'splash.mMain4': '真实可解',
    'splash.sub': '基于数学约束实时校验',
    'splash.hint': '点击任意处进入',

    'chrome.themeToDark': '切换到夜间模式',
    'chrome.themeToLight': '切换到日间模式',
    'chrome.lang': '界面语言',

    'toolbar.solved': '还原',
    'toolbar.random': '随机',
    'toolbar.randomAll': '全部',
    'toolbar.randomRest': '未选',
    'toolbar.randomRestDisabledTip': '当前校验未通过',
    'toolbar.randomMenu': '随机方式',
    'toolbar.clear': '清空',
    'toolbar.undo': '撤销',
    'toolbar.fillUnique': '填充唯一',
    'toolbar.steps': '步骤',
    'toolbar.reverseSteps': '逆向步骤',
    'toolbar.solverLoading': '正在初始化求解器…',

    'toolbar.tip.randomFull':
      '54 面均已填色：点击直接替换为 cubejs 随机合法态',
    'toolbar.tip.randomCentersOnly': '六面仅中心有面色：点击直接整态随机',
    'toolbar.tip.randomPartial':
      '非清空且未填满：展开后可选「全部」或「未选」；五条约束有未通过时「未选」不可用',
    'toolbar.tip.undo': '撤销上一步改色、载入或演示步',
    'toolbar.tip.fillUnique':
      '按 U R F D L B 面顺序，在第一个存在「未填格且约束链候选仅 1 色」的面上，将该面所有此类格填入该色',

    'facelets.apply': '应用',
    'facelets.label': 'facelets54 文本输入，{n}/54 字符',
    'facelets.counter': '{n}/54',
    'facelets.err.len': '须恰好 54 个字符（忽略空白后当前 {n} 个）。',
    'facelets.err.char': '第 {i} 位非法字符 {ch}（仅允许 U、D、L、R、F、B 或未填 {empty}）。',

    'theme.faceColors': '六面显示色与三维透明度',
    'theme.faceSwatches': '六面显示色',
    'theme.faceTitle': '{f} 面显示色',
    'theme.reset': '重置',
    'theme.opacityAria': '三维魔方透明度，0% 不透明，100% 最透明',
    'theme.opacityTitle': '透明度: {n}%',

    'constraints.panel': '约束说明',
    'constraints.statusOk': '当前状态：合法（可解必要条件均满足）',
    'constraints.statusBad': '当前状态：存在非法项或未填色',
    'constraints.pass': '通过',
    'constraints.fail': '未通过',
    'constraints.skipped': '未校验',
    'constraints.validationTreeAria': '3×3 魔方约束校验树',
    'constraints.validationTreeDblclickHint': '双击查看约束校验树（与文档一致）',

    'constraints.edge_position.title': '棱块位置',
    'constraints.edge_position.intro': '12个棱块的排列位置。',
    'constraints.corner_position.title': '角块位置',
    'constraints.corner_position.intro': '8个角块的排列位置。',
    'constraints.edge_flip.title': '棱块翻转',
    'constraints.edge_flip.intro': '棱块翻转的次数是偶数。',
    'constraints.corner_twist.title': '角块扭转',
    'constraints.corner_twist.intro': '角块扭转的次数是3的倍数。',
    'constraints.parity.title': '棱角奇偶',
    'constraints.parity.intro': '棱块位置交换次数=角块位置交换次数，即同为奇数或偶数。',

    'solver.next': '下一步',
    'solver.autoplayPlay': '播放',
    'solver.autoplayPause': '暂停',
    'solver.autoplaySpaceHint': '按空格键播放/暂停',
    'solver.autoplayAria': '自动按间隔执行下一步',
    'solver.stepsAriaForward': '完整还原步骤序列',
    'solver.stepsAriaReverse': '从还原态到目标态的转动序列',
    'solver.done': '（已完成）',
    'solver.currentMove': '当前步',
    'solver.restoreSolved': '恢复还原态',
    'solver.lead.reverse': '逆向步骤：已执行 {cur} / {total}',
    'solver.lead.forward': '还原步骤：已执行 {cur} / {total}',

    'solver.err.fill54': '请先填满 54 格。',
    'solver.err.notSolvableForward': '当前染色不满足可解条件，无法计算还原步骤。',
    'solver.err.notSolvableReverse': '当前染色不满足可解条件，无法计算步骤。',
    'solver.banner.alreadySolvedForward': '当前已是标准还原态，无需转动步骤。',
    'solver.banner.alreadySolvedReverse': '当前已是标准还原态，从还原态到当前态无转动步骤。',
    'solver.err.reverseMismatch':
      '逆向演示结束态与目标不一致（内部错误）；请重新获取逆向步骤。',

    'picker.candidates': '候选颜色',
    'picker.empty': '空',
    'picker.badge': '禁',
    'picker.mutedEmpty': '当前约束链下置空可能不通过，仍可点击',
    'picker.mutedFace': '不在约束链候选集合内，仍可点击选择',
  },
  en: {
    'app.title': 'Cube',
    'app.aria.cube3d': '3×3 cube view: drag to rotate, click stickers to paint',
    'app.aria.io': 'Facelet string input and solution strip',
    'app.aria.toolbar': 'Actions',
    'app.aria.side': 'Colors & constraints',
    'app.aria.chrome': 'Display & language',

    'splash.aria': 'Welcome',
    'splash.main1': 'Define cube colors freely',
    'splash.pcMain2':
      'Every fill you make, every fill we verify — always solvable',
    'splash.mMain2': 'Every fill you make',
    'splash.mMain3': 'Every fill we verify',
    'splash.mMain4': 'Always solvable',
    'splash.sub': 'Real-time validation against mathematical constraints',
    'splash.hint': 'Tap anywhere to continue',

    'chrome.themeToDark': 'Switch to dark mode',
    'chrome.themeToLight': 'Switch to light mode',
    'chrome.lang': 'Interface language',

    'toolbar.solved': 'Reset solved',
    'toolbar.random': 'Random',
    'toolbar.randomAll': 'All',
    'toolbar.randomRest': 'Rest',
    'toolbar.randomRestDisabledTip': 'Current validation failed',
    'toolbar.randomMenu': 'Random mode',
    'toolbar.clear': 'Clear',
    'toolbar.undo': 'Undo',
    'toolbar.fillUnique': 'Fill unique',
    'toolbar.steps': 'Steps',
    'toolbar.reverseSteps': 'Reverse',
    'toolbar.solverLoading': 'Initializing solver…',

    'toolbar.tip.randomFull':
      'All 54 stickers filled: replace with a random legal cubejs state',
    'toolbar.tip.randomCentersOnly': 'Only centers colored: randomize full state',
    'toolbar.tip.randomPartial':
      'Not cleared and not full: menu has “All” or “Rest”; “Rest” is unavailable when any of the five constraints fails',

    'toolbar.tip.undo': 'Undo last color change, load, or demo step',
    'toolbar.tip.fillUnique':
      'Fill faces where chain-B candidates are unique (per face order U R F D L B)',

    'facelets.apply': 'Apply',
    'facelets.label': 'facelets54 text, {n}/54 characters',
    'facelets.counter': '{n}/54',
    'facelets.err.len': 'Must be exactly 54 characters ({n} after removing spaces).',
    'facelets.err.char':
      'Invalid character at position {i}: {ch} (only U,D,L,R,F,B or empty {empty}).',

    'theme.faceColors': 'Face colors & 3D transparency',
    'theme.faceSwatches': 'Display colors',
    'theme.faceTitle': '{f} face color',
    'theme.reset': 'Reset',
    'theme.opacityAria': '3D sticker transparency: 0% opaque, 100% most transparent',
    'theme.opacityTitle': 'Transparency: {n}%',

    'constraints.panel': 'Constraints',
    'constraints.statusOk': 'State: legal (necessary solvability checks pass)',
    'constraints.statusBad': 'State: illegal cells or empty stickers',
    'constraints.pass': 'OK',
    'constraints.fail': 'Fail',
    'constraints.skipped': 'N/A',
    'constraints.validationTreeAria': '3×3 cube constraint validation tree',
    'constraints.validationTreeDblclickHint': 'Double-click to view the validation tree (same as docs)',

    'constraints.edge_position.title': 'Edge permutation',
    'constraints.edge_position.intro': 'Permutation of the 12 edge pieces.',
    'constraints.corner_position.title': 'Corner permutation',
    'constraints.corner_position.intro': 'Permutation of the 8 corner pieces.',
    'constraints.edge_flip.title': 'Edge Orientation',
    'constraints.edge_flip.intro': 'Total edge flips are even.',
    'constraints.corner_twist.title': 'Corner Orientation',
    'constraints.corner_twist.intro': 'Corner twists sum to a multiple of 3.',
    'constraints.parity.title': 'Edge-Corner Parity',
    'constraints.parity.intro': 'Edge and corner permutation parities match (both odd or both even).',

    'solver.next': 'Next',
    'solver.autoplayPlay': 'Play',
    'solver.autoplayPause': 'Pause',
    'solver.autoplaySpaceHint': 'Press Space to play or pause',
    'solver.autoplayAria': 'Auto-advance solution steps on an interval',
    'solver.stepsAriaForward': 'Full solution move sequence',
    'solver.stepsAriaReverse': 'Moves from solved to target state',
    'solver.done': '(done)',
    'solver.currentMove': 'Current',
    'solver.restoreSolved': 'restore solved state',
    'solver.lead.reverse': 'Reverse: {cur} / {total} applied',
    'solver.lead.forward': 'Solution: {cur} / {total} applied',

    'solver.err.fill54': 'Fill all 54 stickers first.',
    'solver.err.notSolvableForward': 'Pattern is not solvable; cannot compute solution.',
    'solver.err.notSolvableReverse': 'Pattern is not solvable; cannot compute reverse moves.',
    'solver.banner.alreadySolvedForward': 'Already in standard solved state; no moves.',
    'solver.banner.alreadySolvedReverse': 'Solved state: no moves to reach current pattern.',
    'solver.err.reverseMismatch':
      'Reverse demo end state mismatch (internal error); fetch reverse steps again.',

    'picker.candidates': 'Color candidates',
    'picker.empty': '∅',
    'picker.badge': '!',
    'picker.mutedEmpty': 'Clearing may violate constraints; still clickable',
    'picker.mutedFace': 'Outside chain candidates; still clickable',
  },
};
