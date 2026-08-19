/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Uma página, duas fontes. Tela e câmera são painéis independentes, cada um com
 * sua própria conexão e seu próprio ligar/desligar — abrir uma aba por fonte
 * dobraria as janelas que a pessoa precisa manter vivas, e nenhuma delas pode
 * ser fechada enquanto transmite.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError } from '/shared/broadcaster.js?v=5';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

const FONTES = ['tela', 'camera'];
const TITULO = document.title;

/**
 * As opções da transmissão, decididas na engrenagem da atividade.
 *
 * Chegam pela URL quando esta aba é aberta e podem ser trocadas depois, pelo
 * `start-request` — a aba costuma estar aberta desde antes da última mexida.
 * Não há controle aqui: dois lugares para a mesma escolha significam um deles
 * desatualizado, e o que fica velho é sempre o que não foi usado por último.
 */
const opcoes = {
  bitrate: Number(query.get('q')) || 2_500_000,
  fps: Number(query.get('fps')) || 30,
  som: query.get('som') === '1',
};

function aplicarOpcoes(novas) {
  if (!novas) return;
  if (Number(novas.q)) opcoes.bitrate = Number(novas.q);
  if (Number(novas.fps)) opcoes.fps = Number(novas.fps);
  if (novas.som !== undefined) opcoes.som = novas.som === '1';
  mostrarOpcoes();
}

function mostrarOpcoes() {
  const mbps = (opcoes.bitrate / 1e6).toFixed(1).replace('.', ',');
  $('presetLine').textContent =
    `${mbps} Mb/s · ${opcoes.fps} fps${opcoes.som ? ' · com som' : ' · sem som'}`;

  // A nota da tela acompanha: com som ela explica a caixa que o navegador
  // mostra; sem som, diz onde ligar, que já não é aqui.
  $('tela-nota').textContent = opcoes.som
    ? 'Marque também "Compartilhar o áudio" na janela que o navegador abrir — sem isso ele entrega a tela sem som.'
    : 'Esta transmissão vai sem som. Para ligar, use a engrenagem na atividade do Discord.';
}

const paineis = {};

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  $('roomLine').textContent = titulo;
  $('setup').hidden = true;
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  const el = $('pageStatus');
  el.textContent = msg;
  el.className = 'status error';
}

// --------------------------------------------------------------- chamamento

let piscando = null;

/**
 * Destaca a fonte que a atividade pediu e chama pelo título.
 *
 * Uma aba em segundo plano não pode se trazer para a frente: `window.focus()` é
 * ignorado, e quem abriu esta página foi o navegador do sistema, não uma página
 * nossa que pudesse chamá-la de volta. O título é o único lugar onde ela ainda
 * aparece para quem está olhando outra coisa.
 */
function chamar(fonte) {
  for (const f of FONTES) $(`bloco-${f}`).classList.toggle('chamando', f === fonte);

  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
  if (!fonte) return;

  // Piscar só serve para quem não está olhando; com a aba à frente, o destaque
  // no bloco já diz qual é.
  if (!document.hidden) return;

  const aviso = fonte === 'camera' ? '● Ligar a câmera' : '● Compartilhar a tela';
  let ligado = false;
  piscando = setInterval(() => {
    ligado = !ligado;
    document.title = ligado ? aviso : TITULO;
  }, 1200);
}

// Visto o recado, para de piscar — o destaque no bloco continua dizendo qual é.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !piscando) return;
  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
});

/**
 * A atividade pediu uma fonte.
 *
 * Câmera dá para ligar daqui mesmo: getUserMedia não exige gesto do usuário
 * depois que a permissão foi concedida. Tela não — `getDisplayMedia` exige
 * ativação transitória e lança InvalidStateError sem ela, então o seletor só
 * abre a partir de um clique nesta página. O que resta é chamar e esperar.
 */
/**
 * A configuração mudou na engrenagem da atividade.
 *
 * Vale na hora para o que já está no ar — menos o som, que é decidido no
 * momento da captura e só mudaria escolhendo a tela de novo.
 */
function aplicarConfig(novas) {
  aplicarOpcoes(novas);
  for (const f of FONTES) paineis[f]?.aplicarQualidade();
}

function atenderPedido(fonte, novas) {
  aplicarOpcoes(novas);

  const painel = paineis[fonte];
  if (!painel || painel.ativo()) return;

  chamar(fonte);
  if (fonte === 'camera') painel.ligar();
}

// --------------------------------------------------------------- controle

/**
 * Conexão de controle: aberta ao carregar, viva enquanto esta aba estiver.
 *
 * É por ela que a atividade alcança esta página **antes** de existir qualquer
 * transmissão — para pedir uma fonte, ou para avisar que a configuração mudou.
 * As conexões de transmissão não serviriam: cada uma nasce só depois que a
 * captura foi concedida, então com nada no ar não há ninguém escutando.
 */
let controle = null;
let religar = null;

function ligarControle() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  controle = new WebSocket(
    `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&modo=controle`
  );

  controle.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === 'start-request') atenderPedido(msg.fonte, msg.opcoes);
    else if (msg.type === 'config-request') aplicarConfig(msg.opcoes);
    else if (msg.type === 'room-gone') {
      // Sala fechada: não há a quem transmitir, e insistir na reconexão só
      // gastaria rede contra um id que não existe mais.
      clearTimeout(religar);
      religar = 'morto';
      $('pageStatus').textContent = 'A sala foi fechada. Volte à atividade e comece de novo.';
      $('pageStatus').className = 'status aviso';
    }
  });

  // Sem reconectar, uma queda de rede deixa a aba aberta e surda, sem nada na
  // tela dizendo que ela parou de obedecer à atividade.
  controle.addEventListener('close', () => {
    controle = null;
    if (religar === 'morto') return;
    clearTimeout(religar);
    religar = setTimeout(ligarControle, 3000);
  });
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;
  let curtas = 0;
  let ritmoAvisado = false;

  function setStatus(msg, kind = '') {
    const alvo = el('status');
    alvo.textContent = msg;
    alvo.className = `status ${kind}`;
  }

  /**
   * Avisa quando o computador não está entregando os quadros pedidos.
   *
   * O encoder por software (vp8, quando não há H264 por hardware) não acompanha
   * 60 fps em tela grande. O backpressure então descarta quadros — o que é a
   * decisão certa, porque fila no encoder vira atraso que nunca mais sai — mas
   * sem este aviso a pessoa escolhe 60, recebe 35 e não fica sabendo.
   */
  function conferirRitmo({ fps, seconds }) {
    const alvo = opcoes.fps;
    if (ritmoAvisado || seconds < 4) return;

    curtas = fps < alvo * 0.7 ? curtas + 1 : 0;
    if (curtas < 4) return;

    ritmoAvisado = true;
    setStatus(
      `Seu computador está entregando ~${fps} dos ${alvo} quadros pedidos. ` +
        'Para uma imagem mais estável, pare e escolha uma taxa menor.',
      'aviso'
    );
  }

  function mostrarSetup() {
    el('preview').srcObject = null;
    el('live').hidden = true;
    el('setup').hidden = false;
    el('start').disabled = false;
  }

  async function ligar() {
    // Pedido repetido não reabre nada: a segunda conexão seria recusada pelo
    // servidor, e o seletor de tela abriria por cima do que já está no ar.
    if (broadcaster) return;

    curtas = 0;
    ritmoAvisado = false;
    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';

    broadcaster = createBroadcaster({
      wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}`,
      bitrate: opcoes.bitrate,
      fps: opcoes.fps,
      audio: !camera && opcoes.som,
      fonte,
      onStatus: (s) =>
        setStatus(
          `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}`
        ),
      onStats: (s) => {
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
        conferirRitmo(s);
      },
      onAviso: (msg) => {
        setStatus(msg, 'aviso');
        // O aviso sozinho é um beco: o botão é a saída dele.
        if (!camera) $('somAba').hidden = false;
      },
      onEnd: (reason) => {
        broadcaster = null;
        mostrarSetup();
        setStatus(reason);
      },
    });

    try {
      const stream = await broadcaster.start();
      el('preview').srcObject = stream;
      el('preview').play().catch(() => {});
      el('setup').hidden = true;
      el('live').hidden = false;
      chamar(null);
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      // NotAllowedError quer dizer coisas diferentes nas duas fontes: na tela é
      // quase sempre cancelar o seletor; na câmera é a permissão negada.
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela.';
      setStatus(err.name === 'NotAllowedError' ? negado : err.message, 'error');
    }
  }

  el('start').addEventListener('click', ligar);
  el('stop').addEventListener('click', () =>
    broadcaster?.stop(camera ? 'Câmera desligada.' : 'Transmissão encerrada.')
  );

  return {
    ligar,
    setStatus,
    aplicarQualidade: () => broadcaster?.setQuality({ bitrate: opcoes.bitrate, fps: opcoes.fps }),
    ativo: () => Boolean(broadcaster),
    parar: () => broadcaster?.stop(),
    trocarSom: () => broadcaster?.trocarSom(),
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  falhar('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  mostrarOpcoes();

  for (const f of FONTES) paineis[f] = criarPainel(f);
  ligarControle();

  // A atividade diz qual fonte motivou a abertura da aba. A tela espera o
  // clique; a câmera pode subir sozinha, mas só depois que a página apareceu —
  // pedir permissão numa aba que o navegador acabou de abrir em segundo plano
  // deixaria o pedido preso sem ninguém ver.
  const pedida = query.get('fonte');
  if (FONTES.includes(pedida)) atenderPedido(pedida);
}

// Mantém o vídeo como está e troca só de onde vem o som — a única fonte que
// não carrega o Discord junto é uma aba.
$('somAba').addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    await paineis.tela.trocarSom();
    paineis.tela.setStatus('Som ligado, vindo da aba escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a aba do som';
  } catch (err) {
    // Cancelar a segunda janela é escolha, não falha.
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});
