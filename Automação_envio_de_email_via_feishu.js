// ==UserScript==
// @name         JMS - Validação de Placas + E-mail de cadastro
// @namespace    jms-automacao
// @version      5.3
// @description  Confere as placas da planilha VALIDACAO_JMS na RELAÇÃO DE PLACAS do Feishu e envia pelo Feishu Mail um e-mail para cada transportadora com as placas que faltam cadastrar
// @match        *://*/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/*
 * COMO FUNCIONA
 *   1. Na planilha VALIDACAO_JMS aparece o painel "Validação de placas". Clique em "Validar placas".
 *   2. O script lê a aba aberta (coluna K = transportadora, coluna M = placa) e a tabela
 *      RELAÇÃO DE PLACAS do Feishu.
 *   3. A placa está OK quando o Feishu tem ESSA placa cadastrada para ESSA transportadora
 *      (a planilha é quem manda). Se não tiver, falta cadastro.
 *   4. As placas que faltam são agrupadas por transportadora (um e-mail para cada) e vão
 *      para uma fila. O Feishu Mail abre numa aba nova e envia a fila sozinho.
 *
 * ONDE MEXER
 *   Planilha, colunas e Base do Feishu ....... PARTE 1
 *   E-mails das transportadoras .............. PARTE 2
 *   Assunto e texto do e-mail ................ PARTE 3
 *   Tempos de espera (PC lento) .............. PARTE 4
 *   Da PARTE 5 em diante é o funcionamento: não precisa mexer no uso normal.
 */

(function () {
  'use strict';

  // ===========================================================================
  // PARTE 1 - PLANILHA E BASE DO FEISHU
  // ===========================================================================

  const PLANILHA = {
    nomeArquivo: 'VALIDACAO_JMS', // o painel só aparece em planilhas com este texto no título
    colunaTransportadora: 'K',
    colunaPlaca: 'M',
  };

  // Base "Forms_Transportadores", tabela RELAÇÃO DE PLACAS.
  // O App Secret é uma SENHA: não compartilhe este arquivo fora da equipe.
  // O app precisa de "Pode ler" na Base (Compartilhar -> adicionar o app).
  const FEISHU = {
    appId: 'confidencial',
    appSecret: 'confidencial',
    appToken: 'confidencial',
    tableId: 'confidencial',
    // nomes das colunas na tabela (se não achar igual, usa a que contém "placa" / "transportador")
    colunaPlaca: 'PLACA',
    colunaTransportadora: 'NOME DO TRANSPORTADOR',
  };

  // Testes:
  //   MODO_TESTE = true  -> lê só as primeiras QTD_TESTE placas da planilha
  //   EMAIL_TESTE = 'x@y' -> TODOS os e-mails vão para x@y (um por transportadora, com
  //                          "[TESTE - EMPRESA]" no assunto) em vez de ir para as transportadoras.
  //                          Mais de um: 'x@y; z@w'. Para valer de verdade: ''
  const MODO_TESTE = false;
  const QTD_TESTE = 5;
  const EMAIL_TESTE = '';

  // ===========================================================================
  // PARTE 2 - E-MAILS DAS TRANSPORTADORAS
  // ===========================================================================
  // Nome (como na coluna K da planilha) -> e-mails. Todos os e-mails da lista vão juntos
  // no "To" de UM e-mail só (não manda um e-mail para cada endereço).
  // Maiúscula, acento e pontuação não importam. Se o nome não for igual, também vale quando
  // um contém o outro como palavras inteiras ("CEOS EXPRESS" acha "CEOS EXPRESS LTDA").
  // Transportadora nova: adicione uma linha.

  const EMAILS_FIXOS = {
    'confidencial': 'confidencial'
  };

  // ===========================================================================
  // PARTE 3 - E-MAIL
  // ===========================================================================

  const EMAIL = {
    urlFeishuMail: 'confidencial',
    assunto: 'Solicitação de Cadastro / Ajuste de Veículos',
    copia: ['confidencial'], // Cc fixo em todos os e-mails ([] = sem Cc)
    linkForms: 'confidencial'
  };

  // Corpo do e-mail: cada item da lista é uma linha ('' = linha em branco)
  function corpoDoEmail(placas) {
    return [
      'Olá,',
      '',
      'Para que o cadastro de Placas esteja atualizado e não haja FALTA DE PAGAMENTO DOS IDS cadastrem as placas abaixo no forms:',
      ...placas.map((placa) => `- ${placa}`),
      '',
      EMAIL.linkForms,
    ];
  }

  // ===========================================================================
  // PARTE 4 - TEMPOS (em milissegundos: 1000 = 1 segundo)
  // ===========================================================================

  const TEMPO = {
    pausa: 600, // entre cada clique/digitação no Feishu Mail (aumente se o PC estiver lento)
    esperaCarregar: 3000, // depois que o Feishu Mail mostra o botão Compose, antes de começar
    esperaElemento: 20000, // máximo esperando um campo/botão aparecer
    esperaFeishuMail: 60000, // máximo esperando o Feishu Mail abrir
    esperaEnvio: 10000, // máximo esperando a janela fechar depois do Send
    validadeFila: 10 * 60 * 1000, // fila mais velha que isto não é enviada sozinha
    travaValida: 2 * 60 * 1000, // sem sinal de vida por este tempo, a aba que enviava é dada como fechada
  };

  // ===========================================================================
  // PARTE 5 - INÍCIO (escolhe o que fazer conforme a página)
  // ===========================================================================

  // Dados guardados no Tampermonkey (compartilhados entre a aba da planilha e a do Feishu Mail)
  const CHAVE = {
    fila: 'fila_emails', // [{ email: 'a@x.com; b@x.com', transportadora, placas: [...] }, ...]
    filaCriada: 'fila_emails_quando',
    trava: 'fila_enviando', // horário do último sinal de vida da aba que está enviando
    token: 'feishu_token',
  };

  let painel = null; // painel da página (PARTE 10)
  let ocupado = false; // impede clicar duas vezes enquanto algo está rodando

  // (a chamada fica no fim do arquivo, depois de tudo estar definido)
  function iniciar() {
    if (location.hostname === 'docs.google.com') iniciarPlanilha();
    else iniciarFeishuMail();
  }

  // ===========================================================================
  // PARTE 6 - PÁGINA DA PLANILHA: validar
  // ===========================================================================

  async function iniciarPlanilha() {
    // o título da planilha aparece alguns segundos depois da página
    const ehAPlanilha = () => normalizarNome(document.title).includes(normalizarNome(PLANILHA.nomeArquivo));
    for (let i = 0; i < 30 && !ehAPlanilha(); i++) await esperar(1000);
    if (!ehAPlanilha()) return;

    painel = criarPainel('planilha', 'Validação de placas');
    painel.status('Pronto para validar a aba aberta.');
    painel.botao('Validar placas', validar);
  }

  async function validar() {
    if (ocupado) return;
    if (filaSendoEnviada()) {
      painel.status('Ainda há e-mails sendo enviados no Feishu Mail. Espere terminar e valide de novo.', 'aviso');
      return;
    }
    ocupado = true;
    painel.botao('Validando...', null);
    painel.limpar();
    try {
      painel.status('Lendo a planilha...', 'rodando');
      const linhas = await lerPlanilha();
      if (!linhas.length) throw new Error(`Nenhuma placa encontrada na coluna ${PLANILHA.colunaPlaca}.`);

      painel.status('Lendo a RELAÇÃO DE PLACAS no Feishu...', 'rodando');
      const cadastro = await lerCadastroFeishu();

      const faltando = compararPlacas(linhas, cadastro);
      const { fila, semEmail } = montarFila(faltando);

      // a aba do Feishu Mail pega a fila daqui (uma validação nova substitui a fila antiga)
      GM_setValue(CHAVE.fila, fila);
      GM_setValue(CHAVE.filaCriada, Date.now());

      painel.numeros([
        ['Placas', linhas.length],
        ['OK', linhas.length - faltando.length],
        ['Sem cadastro', faltando.length],
        ['E-mails', fila.length],
      ]);
      const avisos = [];
      if (semEmail.length) avisos.push(`Sem e-mail cadastrado na PARTE 2: ${semEmail.join(', ')}`);
      if (EMAIL_TESTE && fila.length) avisos.push(`Modo teste: todos os e-mails vão para ${EMAIL_TESTE}`);
      painel.aviso(avisos.join('\n'));
      painel.detalhes(
        faltando.map((f) => `Linha ${f.numero}  ${f.placa}  ${f.transportadora || '(sem transportadora)'}` + (f.cadastradaEm.length ? `  (no Feishu: ${f.cadastradaEm.join(' / ')})` : ''))
      );

      if (fila.length) {
        painel.status(`Abrindo o Feishu Mail para enviar ${fila.length} e-mail(s).`, 'ok');
        GM_openInTab(EMAIL.urlFeishuMail, { active: true }); // window.open seria barrado como pop-up
      } else if (faltando.length) {
        painel.status('Há placas sem cadastro, mas nenhuma das transportadoras tem e-mail na PARTE 2.', 'aviso');
      } else {
        painel.status('Todas as placas estão cadastradas.', 'ok');
      }
    } catch (e) {
      console.error('[Placas]', e);
      painel.status(e.message, 'erro');
    } finally {
      ocupado = false;
      painel.botao('Validar placas', validar);
    }
  }

  // Devolve só as placas que faltam cadastrar:
  // [{ numero, placa, transportadora, cadastradaEm: ['OUTRA EMPRESA'] }, ...]
  function compararPlacas(linhas, cadastro) {
    const faltando = [];
    const relatorio = [];
    for (const { numero, placa, transportadora } of linhas) {
      const empresasNoFeishu = cadastro.get(normalizarPlaca(placa)) || [];
      const ok = empresasNoFeishu.some((empresa) => mesmaEmpresa(empresa, transportadora));
      if (!ok) faltando.push({ numero, placa, transportadora, cadastradaEm: empresasNoFeishu });
      relatorio.push({ linha: numero, placa, transportadora, situacao: ok ? 'OK' : 'FALTA CADASTRO', noFeishu: empresasNoFeishu.join(' / ') });
    }
    console.table(relatorio);
    return faltando;
  }

  // Agrupa as placas que faltam: um e-mail por transportadora
  function montarFila(faltando) {
    const grupos = new Map();
    const semEmail = new Set();
    for (const f of faltando) {
      const emailDaTransportadora = acharEmail(f.transportadora);
      if (!emailDaTransportadora) semEmail.add(f.transportadora || '(sem transportadora)');
      const email = EMAIL_TESTE || emailDaTransportadora;
      if (!email) continue;
      // no teste todas têm o mesmo e-mail, então agrupa pelo nome para continuar um por transportadora
      const chave = EMAIL_TESTE ? normalizarNome(f.transportadora) : email;
      if (!grupos.has(chave)) grupos.set(chave, { email, transportadora: f.transportadora, placas: [] });
      const grupo = grupos.get(chave);
      if (!grupo.placas.includes(f.placa)) grupo.placas.push(f.placa);
    }
    const fila = [...grupos.values()];
    if (fila.length) console.table(fila.map((g) => ({ transportadora: g.transportadora, para: g.email, placas: g.placas.join(', ') })));
    return { fila, semEmail: [...semEmail] };
  }

  // E-mails da transportadora na PARTE 2, como 'a@x.com; b@x.com' ('' se não achar).
  // 1º nome igual; 2º um nome contém o outro como palavras inteiras.
  function acharEmail(transportadora) {
    const alvo = ` ${normalizarNome(transportadora)} `;
    if (!alvo.trim()) return '';
    const lista = Object.entries(EMAILS_FIXOS).map(([nome, emails]) => [` ${normalizarNome(nome)} `, emails]);
    const achado = lista.find(([nome]) => nome === alvo) || lista.find(([nome]) => nome.includes(alvo) || alvo.includes(nome));
    if (!achado) return '';
    return [].concat(achado[1]).map((e) => e.trim()).filter(Boolean).join('; ');
  }

  // Mesma empresa = nome igual, ignorando maiúscula, acento, pontuação e espaços
  // ("TESTE ROBERT" e "TESTE ROBERT 2" são diferentes; empresa vazia nunca é igual)
  function mesmaEmpresa(a, b) {
    const x = normalizarNome(a);
    return x !== '' && x === normalizarNome(b);
  }

  // ===========================================================================
  // PARTE 7 - LEITURA DA PLANILHA (baixa a aba aberta com o seu login do Google)
  // ===========================================================================

  // [{ numero: 3, placa: 'GRU2087', transportadora: 'CHIC TRANSPORTES' }, ...]
  // (numero = número da linha no Google Planilhas; pula cabeçalho e linhas sem placa)
  async function lerPlanilha() {
    const linhas = await baixarAbaAberta();
    const iPlaca = indiceColuna(PLANILHA.colunaPlaca);
    const iTransportadora = indiceColuna(PLANILHA.colunaTransportadora);
    const limite = MODO_TESTE ? QTD_TESTE : Infinity;

    const resultado = [];
    for (let i = 0; i < linhas.length && resultado.length < limite; i++) {
      const placa = String(linhas[i][iPlaca] || '').trim();
      const ehCabecalho = normalizarNome(placa).includes('placa'); // "Placa do carro"
      if (!normalizarPlaca(placa) || ehCabecalho) continue;
      resultado.push({ numero: i + 1, placa, transportadora: String(linhas[i][iTransportadora] || '').trim() });
    }
    return resultado;
  }

  // Tenta, na ordem: 1) só a aba aberta em CSV (Planilha Google)
  //                  2) o arquivo inteiro em .xlsx (serve para .xlsx aberto no Planilhas)
  //                  3) o .xlsx original guardado no Drive
  async function baixarAbaAberta() {
    const id = (location.pathname.match(/\/spreadsheets\/d\/([^/]+)/) || [])[1];
    const gid = (location.hash.match(/gid=(\d+)/) || location.search.match(/gid=(\d+)/) || [])[1] || '0';
    if (!id) throw new Error('Não achei o ID da planilha no endereço da página.');

    try {
      const res = await baixarArquivo('confidencial');
      const texto = new TextDecoder('utf-8').decode(res.response || new ArrayBuffer(0));
      // CSV de verdade não começa com "<" (isso seria uma página de login/erro)
      if (res.status === 200 && texto && !texto.trimStart().startsWith('<')) {
        return lerAba(XLSX.read(texto, { type: 'string', raw: true }));
      }
    } catch (e) {
      console.warn('[Placas] CSV da aba falhou:', e.message);
    }

    try {
      const res = await baixarArquivo('confidencial');
      const bytes = new Uint8Array(res.response || []);
      // .xlsx de verdade começa com "PK" (é um zip)
      if (res.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        return lerAba(XLSX.read(bytes, { type: 'array' }), nomeAbaAberta());
      }
    } catch (e) {
      console.warn('[Placas] Falhou ao baixar de url:', e.message);
    }
    
    throw new Error('Não consegui baixar a planilha. Confira se está logado no Google e tem acesso ao arquivo.');
  }

  // Lê a aba (pelo nome, se tiver; senão a primeira) como lista de linhas, sempre a partir
  // de A1 — sem isso, linhas/colunas vazias no começo são puladas e a contagem sai errada
  function lerAba(livro, nome) {
    const nomeAba = (nome && livro.SheetNames.find((n) => normalizarNome(n) === normalizarNome(nome))) || livro.SheetNames[0];
    const aba = livro.Sheets[nomeAba];
    const fim = XLSX.utils.decode_range(aba['!ref'] || 'A1').e;
    const range = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: fim });
    return XLSX.utils.sheet_to_json(aba, { header: 1, defval: '', raw: false, blankrows: true, range });
  }

  function nomeAbaAberta() {
    const el = document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name');
    return el ? el.textContent.trim() : '';
  }

  function baixarArquivo(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 60000,
        onload: resolve,
        onerror: () => reject(new Error('Erro de rede ao baixar a planilha')),
        ontimeout: () => reject(new Error('A planilha demorou demais para baixar')),
      });
    });
  }

  // "A" -> 0, "K" -> 10, "M" -> 12, "AA" -> 26
  function indiceColuna(letra) {
    return letra.toUpperCase().split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  }

  // ===========================================================================
  // PARTE 8 - LEITURA DO FEISHU (API)
  // ===========================================================================

  // Lê a RELAÇÃO DE PLACAS inteira e devolve um Map:
  //   placa ("GRU2087") -> empresas em que ela está cadastrada (['CHIC TRANSPORTES LTDA', ...])
  // Lê a tabela toda, sem visualização: filtros de uma visualização escondem linhas.
  async function lerCadastroFeishu() {
    
    const tabela = 'confidencial';
    const colunas = (await chamarFeishu('GET', `${tabela}/fields?page_size=100`)).items.map((c) => c.field_name);
    const cPlaca = acharColuna(colunas, FEISHU.colunaPlaca);
    const cTransportadora = acharColuna(colunas, FEISHU.colunaTransportadora);
    if (!cPlaca || !cTransportadora) {
      throw new Error(`Não achei a coluna "${cPlaca ? FEISHU.colunaTransportadora : FEISHU.colunaPlaca}" no Feishu. Colunas: ${colunas.join(', ')}`);
    }

    const cadastro = new Map();
    let pagina = '';
    do {
      const url = `${tabela}/records/search?page_size=500` + (pagina ? `&page_token=${encodeURIComponent(pagina)}` : '');
      const dados = await chamarFeishu('POST', url, { field_names: [cPlaca, cTransportadora] }); // só as 2 colunas: resposta menor
      for (const item of dados.items || []) {
        const placa = normalizarPlaca(textoDoCampo(item.fields[cPlaca]));
        if (!placa) continue;
        if (!cadastro.has(placa)) cadastro.set(placa, []);
        cadastro.get(placa).push(textoDoCampo(item.fields[cTransportadora]).trim());
      }
      pagina = dados.has_more ? dados.page_token : '';
    } while (pagina);

    console.log(`[Placas] Feishu: ${cadastro.size} placas cadastradas`);
    return cadastro;
  }

  // Coluna pelo nome igual; senão a que contém o nome (sem o "nome do": "NOME DO TRANSPORTADOR" -> "transportador")
  function acharColuna(colunas, nome) {
    const alvo = normalizarNome(nome);
    const curto = alvo.replace(/^nome do /, '');
    return colunas.find((c) => normalizarNome(c) === alvo) || colunas.find((c) => normalizarNome(c).includes(curto));
  }

  // Chama a API do Feishu já com o token. Se o token tiver vencido/sido recusado, pega outro e tenta 1 vez mais.
  const ERROS_DE_TOKEN = [99991661, 99991663, 99991664, 99991668];
  async function chamarFeishu(metodo, caminho, corpo) {
    for (let tentativa = 1; ; tentativa++) {
      const token = await pegarToken();
      const resp = await requisicao(metodo, 'confidencial', corpo, token);

      if (resp.code === 0) return resp.data;
      if (ERROS_DE_TOKEN.includes(resp.code) && tentativa === 1) {
        GM_setValue(CHAVE.token, null);
        continue;
      }
      const dicas = {
        91402: 'confira o appToken e o tableId na PARTE 1',
        91403: 'dê permissão "Pode ler" ao app na Base (Compartilhar -> adicionar o app)',
        99991672: 'ative a permissão de leitura de registros do app no Feishu Open Platform e publique uma nova versão',
      };
      if (resp.code === 99991672) GM_setValue(CHAVE.token, null);
      throw new Error(`Erro ao ler o Feishu (code ${resp.code}): ${dicas[resp.code] || resp.msg}`);
    }
  }

  // O token vale ~2h: fica guardado e só pede outro quando faltar menos de 5 min
  async function pegarToken() {
    const guardado = GM_getValue(CHAVE.token, null);
    if (guardado && guardado.expira - Date.now() > 5 * 60 * 1000) return guardado.token;

    const resp = await requisicao('POST', 'confidencial', {
      app_id: FEISHU.appId,
      app_secret: FEISHU.appSecret,
    });
    
    if (resp.code !== 0) throw new Error('Login no Feishu falhou: ' + resp.msg);
    GM_setValue(CHAVE.token, { token: resp.tenant_access_token, expira: Date.now() + resp.expire * 1000 });
    return resp.tenant_access_token;
  }

  // Requisição com até 3 tentativas em caso de falha de rede
  async function requisicao(metodo, url, corpo, token) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        return await requisicaoUmaVez(metodo, url, corpo, token);
      } catch (e) {
        ultimoErro = e;
        if (tentativa < 3) await esperar(1000 * tentativa);
      }
    }
    throw new Error(`${ultimoErro.message} (tentei 3 vezes)`);
  }

  function requisicaoUmaVez(metodo, url, corpo, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: metodo,
        url,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        data: corpo ? JSON.stringify(corpo) : undefined,
        timeout: 20000,
        onload: (res) => {
          if (res.status >= 500) return reject(new Error(`Feishu fora do ar (status ${res.status})`));
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(new Error(`Resposta inválida do Feishu (status ${res.status})`));
          }
        },
        onerror: () => reject(new Error('Erro de rede ao falar com o Feishu')),
        ontimeout: () => reject(new Error('O Feishu demorou demais para responder')),
      });
    });
  }

  // Um campo do Feishu pode vir como texto, [{ text }], { text } ou opção
  function textoDoCampo(valor) {
    if (valor == null) return '';
    if (Array.isArray(valor)) return valor.map((v) => (v && (v.text || v.name)) || v).join('');
    if (typeof valor === 'object') return valor.text || valor.link || '';
    return String(valor);
  }

  // ===========================================================================
  // PARTE 9 - PÁGINA DO FEISHU MAIL: envio da fila
  // ===========================================================================

  const SELETOR = {
    compose: '[class*="composeBtn"], div[data-text="Compose"]',
    editor: 'div[contenteditable="true"].editor-kit-container', // corpo do e-mail
    campoEmail: 'input.mail-search-input', // To e Cc usam o mesmo tipo de campo; o id termina em "-to" / "-cc"
    assunto: 'input[placeholder*="Subject" i], input[placeholder*="Assunto" i], input[placeholder*="主题"], [class*="subject" i] input',
    send: 'button[class*="sendButton"]',
  };

  function iniciarFeishuMail() {
    if (!lerFila().length) return; // nada para enviar: não mostra painel nenhum
    painel = criarPainel('feishu-mail', 'Envio de e-mails');

    const recente = Date.now() - GM_getValue(CHAVE.filaCriada, 0) < TEMPO.validadeFila;
    if (recente && !filaSendoEnviada()) {
      processarFila();
    } else {
      mostrarFilaParada(recente ? 'Outra aba do Feishu Mail já está enviando esta fila.' : 'Há e-mails de uma validação antiga aguardando.');
    }
  }

  function mostrarFilaParada(texto, tipo = 'aviso') {
    const n = lerFila().length;
    painel.status(texto, tipo);
    painel.botao(n ? `Enviar ${n} e-mail(s)` : '', n ? processarFila : null);
  }

  // Pausar: termina o e-mail que está sendo escrito e para antes do próximo
  // (parar no meio deixaria um e-mail pela metade). "Continuar" segue de onde parou.
  let pausaPedida = false;
  function pedirPausa() {
    pausaPedida = true;
    painel.botao('Pausando...', null);
  }

  // Envia a fila inteira, um e-mail por vez. Se der erro, para e mostra o motivo.
  async function processarFila() {
    if (ocupado) return;
    if (filaSendoEnviada()) return mostrarFilaParada('Outra aba do Feishu Mail já está enviando esta fila.');
    const total = lerFila().length;
    if (!total) return mostrarFilaParada('Nenhum e-mail na fila.', 'ok');

    ocupado = true;
    pausaPedida = false;
    const sinalDeVida = travarFila();
    const tituloOriginal = document.title;
    let enviados = 0;
    painel.botao('Pausar', pedirPausa);
    painel.limpar();
    try {
      painel.status('Esperando o Feishu Mail carregar...', 'rodando');
      await esperarElemento(acharCompose, 'o botão Compose', TEMPO.esperaFeishuMail);
      await esperar(TEMPO.esperaCarregar); // o botão aparece antes de a página responder ao clique

      let item;
      while (!pausaPedida && (item = tirarDaFila())) {
        painel.status(`Enviando ${enviados + 1} de ${total}: ${item.transportadora}`, 'rodando');
        document.title = `Enviando ${enviados + 1} de ${total}`;
        try {
          await enviarEmail(item);
        } catch (e) {
          if (!e.talvezEnviado) devolverParaFila(item); // não reenvia o que pode já ter saído
          throw e;
        }
        enviados++;
        painel.numeros([['Total', total], ['Enviados', enviados], ['Restantes', total - enviados]]);
        painel.adicionarDetalhe(`${item.transportadora}  ${item.placas.length} placa(s)`);
        await esperar(TEMPO.pausa * 2);
      }
      const restantes = lerFila().length;
      if (pausaPedida && restantes) painel.status(`Pausado. ${enviados} enviado(s), ${restantes} aguardando.`, 'aviso');
      else painel.status(`Concluído: ${enviados} e-mail(s) enviado(s).`, 'ok');
    } catch (e) {
      console.error('[Placas]', e);
      painel.status(e.message, 'erro');
    } finally {
      ocupado = false;
      liberarFila(sinalDeVida);
      document.title = tituloOriginal;
      const restantes = lerFila().length;
      const texto = pausaPedida ? `Continuar (${restantes})` : `Tentar de novo (${restantes})`;
      painel.botao(restantes ? texto : '', restantes ? processarFila : null);
    }
  }

  // Compose -> To -> Subject -> corpo -> Send -> espera a janela fechar
  async function enviarEmail(item) {
    // 1) Abre uma janela NOVA (pode haver outras abertas) e trabalha só dentro dela.
    //    Se não abrir, clica de novo (até 3 vezes).
    const editoresAntes = new Set(document.querySelectorAll(SELETOR.editor));
    const editorNovo = () => [...document.querySelectorAll(SELETOR.editor)].find((e) => !editoresAntes.has(e));
    let editor = null;
    for (let tentativa = 1; tentativa <= 3 && !editor; tentativa++) {
      clicar(await esperarElemento(acharCompose, 'o botão Compose'));
      editor = await esperarElemento(editorNovo, 'a janela do e-mail', 5000).catch(() => null);
    }
    if (!editor) throw new Error('Cliquei em Compose 3 vezes e a janela do e-mail não abriu.');
    const janela = await esperarElemento(() => acharJanela(editor), 'a janela do e-mail');
    await esperar(TEMPO.pausa * 2);

    // 2) To e Cc: todos os e-mails no mesmo campo (cada um vira uma "etiqueta" ao apertar Enter)
    const campoPara = () => janela.querySelector(`${SELETOR.campoEmail}[id$="-to"]`) || janela.querySelector(SELETOR.campoEmail);
    await preencherEmails(campoPara, item.email.split(/[;,\s]+/), 'To');
    if (EMAIL.copia.length) {
      await abrirCampoCc(janela);
      await preencherEmails(() => janela.querySelector(`${SELETOR.campoEmail}[id$="-cc"]`), EMAIL.copia, 'Cc');
    }

    // 3) Subject (no teste, mostra de qual transportadora é: o corpo não tem o nome)
    const campoAssunto = janela.querySelector(SELETOR.assunto);
    if (!campoAssunto) throw new Error('Não achei o campo Subject na janela do e-mail.');
    await digitar(campoAssunto, EMAIL_TESTE ? `[TESTE - ${item.transportadora}] ${EMAIL.assunto}` : EMAIL.assunto);

    // 4) Corpo
    await escreverCorpo(editor, corpoDoEmail(item.placas), item.placas);

    // 5) Send
    const botaoSend = janela.querySelector(SELETOR.send) || [...janela.querySelectorAll('button')].find((b) => ['send', 'enviar', '发送'].includes(b.textContent.trim().toLowerCase()));
    if (!botaoSend) throw new Error('Não achei o botão Send.');
    botaoSend.click();

    // 6) O Feishu fecha a janela quando envia. Se ela continuar aberta, algo travou o envio
    //    (ex.: aviso na tela): para e deixa a janela aberta para você conferir.
    const inicio = Date.now();
    while (document.contains(janela) && Date.now() - inicio < TEMPO.esperaEnvio) await esperar(300);
    if (document.contains(janela)) {
      const erro = new Error(`Cliquei em Send para ${item.transportadora}, mas a janela não fechou. Confira a janela e a pasta Sent antes de tentar de novo.`);
      erro.talvezEnviado = true;
      throw erro;
    }
    console.log(`[Placas] Enviado para ${item.transportadora} (${item.email}):`, item.placas);
  }

  // Botão Compose visível (pode haver cópias escondidas na página)
  function acharCompose() {
    const visivel = (el) => el.getBoundingClientRect().width > 0;
    const alvo = [...document.querySelectorAll(SELETOR.compose)].find(visivel) || acharPorTexto(['compose', '+ compose', 'escrever', '写邮件', '写信']);
    return alvo ? alvo.closest('button') || alvo : null;
  }

  // Janela do e-mail = o 1º bloco em volta do editor que tem o botão Send E o campo To
  // (o editor e o Send ficam num bloco separado do cabeçalho To/Subject)
  function acharJanela(editor) {
    for (let el = editor.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector(SELETOR.send) && el.querySelector(SELETOR.campoEmail)) return el;
    }
    return null;
  }

  // Campo Cc: se ainda não estiver na tela, clica em "Cc" para abrir
  async function abrirCampoCc(janela) {
    const campo = () => janela.querySelector(`${SELETOR.campoEmail}[id$="-cc"]`);
    if (!campo()) {
      const rotulo = [...janela.querySelectorAll('div, span, a')].find((el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === 'cc');
      if (rotulo) clicar(rotulo);
    }
    await esperarElemento(campo, 'o campo Cc', 5000);
  }

  // Coloca todos os e-mails no mesmo campo: digita, aperta Enter (vira etiqueta) e vai para o próximo.
  // "acharCampo" é uma função porque o Feishu troca a caixinha de digitação a cada etiqueta
  // criada: guardar a caixinha antiga fazia só o 1º e-mail entrar.
  async function preencherEmails(acharCampo, emails, nomeCampo) {
    for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
      let virouEtiqueta = false;
      for (let tentativa = 1; tentativa <= 3 && !virouEtiqueta; tentativa++) {
        const campo = await esperarElemento(acharCampo, `o campo ${nomeCampo}`);
        await digitar(campo, email);
        apertarEnter(acharCampo() || campo);
        await esperar(TEMPO.pausa);
        // virou etiqueta = a caixinha de digitação ficou vazia de novo
        const depois = acharCampo();
        virouEtiqueta = !!depois && !depois.value.includes(email);
        if (!virouEtiqueta && depois) {
          limparCampo(depois); // não deixa o texto pela metade para a próxima tentativa
          await esperar(TEMPO.pausa);
        }
      }
      if (!virouEtiqueta) throw new Error(`Não consegui colocar ${email} no ${nomeCampo}.`);
    }
  }

  function limparCampo(input) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // O editor do corpo ignora "Enter" feito por script, então o texto entra como se fosse
  // colado (Ctrl+V). Se não pegar, escreve tudo numa linha só.
  async function escreverCorpo(editor, linhas, placas) {
    const temTudo = () => placas.every((p) => editor.innerText.includes(p));
    const escapar = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    editor.focus();
    await esperar(TEMPO.pausa);
    const dados = new DataTransfer();
    dados.setData('text/plain', linhas.join('\n'));
    dados.setData('text/html', linhas.map((l) => `<p>${escapar(l) || '<br>'}</p>`).join(''));
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dados, bubbles: true, cancelable: true }));
    await esperar(TEMPO.pausa * 2);
    if (temTudo()) return;

    console.warn('[Placas] Colar não funcionou, escrevendo numa linha só');
    editor.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, linhas.filter(Boolean).join(' '));
    await esperar(TEMPO.pausa);
    if (!temTudo()) throw new Error('Não consegui escrever as placas no corpo do e-mail.');
  }

  // Digita num campo de forma que o Feishu perceba
  async function digitar(input, texto) {
    input.focus();
    await esperar(TEMPO.pausa / 2);
    document.execCommand('insertText', false, texto);
    if (!input.value.includes(texto)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, texto);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await esperar(TEMPO.pausa);
  }

  function apertarEnter(el) {
    for (const tipo of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(tipo, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Clique completo (o Feishu às vezes só reage ao apertar/soltar do mouse).
  // Não usar "view: window": no Tampermonkey o window é uma cópia e o Chrome recusa o evento.
  function clicar(el) {
    const r = el.getBoundingClientRect();
    const opcoes = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opcoes));
    el.dispatchEvent(new MouseEvent('mousedown', opcoes));
    el.dispatchEvent(new PointerEvent('pointerup', opcoes));
    el.dispatchEvent(new MouseEvent('mouseup', opcoes));
    el.click();
  }

  // Elemento visível cujo texto é exatamente um dos textos
  function acharPorTexto(textos) {
    return [...document.querySelectorAll('button, div, span, a')].find(
      (el) => el.offsetParent && el.children.length <= 2 && textos.includes(el.textContent.trim().toLowerCase())
    );
  }

  // --- Fila de e-mails (guardada no Tampermonkey) ---

  function lerFila() {
    return GM_getValue(CHAVE.fila, []).filter((i) => i && i.email && Array.isArray(i.placas));
  }

  // Tira o 1º da fila antes de enviar, para nunca enviar o mesmo duas vezes
  function tirarDaFila() {
    const fila = lerFila();
    const item = fila.shift();
    GM_setValue(CHAVE.fila, fila);
    return item;
  }

  function devolverParaFila(item) {
    GM_setValue(CHAVE.fila, [item, ...lerFila()]);
  }

  // Trava: enquanto uma aba envia, ela marca um "sinal de vida" a cada 5 s. Assim outra
  // aba do Feishu Mail não envia a mesma fila junto, e a planilha não troca a fila no meio.
  function filaSendoEnviada() {
    return Date.now() - GM_getValue(CHAVE.trava, 0) < TEMPO.travaValida;
  }

  function travarFila() {
    GM_setValue(CHAVE.trava, Date.now());
    return setInterval(() => GM_setValue(CHAVE.trava, Date.now()), 5000);
  }

  function liberarFila(sinalDeVida) {
    clearInterval(sinalDeVida);
    GM_setValue(CHAVE.trava, 0);
  }

  // ===========================================================================
  // PARTE 10 - PAINEL (o quadro no canto da tela)
  // ===========================================================================
  // Arraste pelo cabeçalho para mudar de lugar; botão do canto minimiza/abre (os dois ficam lembrados).

  const ESTILO = `
    .jms-painel { position: fixed; right: 20px; bottom: 24px; z-index: 2147483000; width: 340px;
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2329;
      background: #fff; border: 1px solid #dee0e3; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(31, 35, 41, .12); overflow: hidden; }
    .jms-painel * { box-sizing: border-box; }
    .jms-cab { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move; user-select: none; touch-action: none; }
    .jms-ponto { width: 8px; height: 8px; border-radius: 50%; background: #8f959e; flex: none; }
    .jms-ponto[data-tipo="rodando"] { background: #3370ff; animation: jms-pulsar 1.2s infinite; }
    .jms-ponto[data-tipo="ok"] { background: #34c724; }
    .jms-ponto[data-tipo="aviso"] { background: #ff8800; }
    .jms-ponto[data-tipo="erro"] { background: #f54a45; }
    @keyframes jms-pulsar { 50% { opacity: .35; } }
    .jms-titulo { flex: 1; font-weight: 600; }
    .jms-min { width: 22px; height: 22px; border: 0; border-radius: 4px; background: transparent;
      color: #646a73; font: 16px/1 Arial, sans-serif; cursor: pointer; }
    .jms-min:hover { background: #f2f3f5; }
    .jms-corpo { padding: 0 12px 12px; border-top: 1px solid #eff0f1; }
    .jms-minimizado { width: auto; min-width: 200px; }
    .jms-minimizado .jms-corpo { display: none; }
    .jms-msg { padding-top: 10px; color: #1f2329; white-space: pre-line; word-break: break-word; }
    .jms-msg[data-tipo="erro"] { color: #d83931; }
    .jms-numeros { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
    .jms-num { background: #f5f6f7; border-radius: 6px; padding: 6px 8px; }
    .jms-num strong { display: block; font-size: 16px; font-weight: 600; }
    .jms-num span { font-size: 11px; color: #8f959e; }
    .jms-aviso { margin-top: 10px; padding: 6px 8px; border-radius: 6px; background: #fff5eb;
      color: #a45c00; font-size: 12px; white-space: pre-line; }
    .jms-detalhes { margin-top: 10px; max-height: 170px; overflow: auto; font-size: 12px; color: #646a73;
      border-top: 1px solid #eff0f1; }
    .jms-detalhes div { padding: 4px 0; border-bottom: 1px solid #f5f6f7; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    .jms-numeros:empty, .jms-aviso:empty, .jms-detalhes:empty { display: none; }
    .jms-botao { width: 100%; margin-top: 12px; padding: 8px; border: 0; border-radius: 6px;
      background: #3370ff; color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .jms-botao:hover:not(:disabled) { background: #245bdb; }
    .jms-botao:disabled { background: #bacefd; cursor: default; }
  `;

  // Cria o painel e devolve as funções para mexer nele:
  //   status(texto, tipo)   tipo: 'neutro' | 'rodando' | 'ok' | 'aviso' | 'erro'
  //   numeros([[rotulo, valor], ...])   aviso(texto)   detalhes([linhas])   adicionarDetalhe(linha)
  //   botao(texto, aoClicar)   (texto vazio esconde; aoClicar null desativa)   limpar()
  function criarPainel(id, titulo) {
    if (!document.getElementById('jms-estilo')) {
      const style = criarEl('style', null, ESTILO);
      style.id = 'jms-estilo';
      document.head.appendChild(style);
    }

    const ponto = criarEl('span', 'jms-ponto');
    const btnMin = criarEl('button', 'jms-min');
    btnMin.type = 'button';
    const cab = criarEl('div', 'jms-cab');
    cab.append(ponto, criarEl('span', 'jms-titulo', titulo), btnMin);

    const msg = criarEl('div', 'jms-msg');
    const numeros = criarEl('div', 'jms-numeros');
    const aviso = criarEl('div', 'jms-aviso');
    const detalhes = criarEl('div', 'jms-detalhes');
    const botao = criarEl('button', 'jms-botao');
    botao.type = 'button';
    const corpo = criarEl('div', 'jms-corpo');
    corpo.append(msg, numeros, aviso, detalhes, botao);

    const raiz = criarEl('div', 'jms-painel');
    raiz.append(cab, corpo);
    document.body.appendChild(raiz);

    // posição: arraste pelo cabeçalho (lembrada por página; sempre dentro da tela)
    const chavePos = `painel_posicao_${id}`;
    const posicionar = (x, y) => {
      const maxX = Math.max(0, window.innerWidth - raiz.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - raiz.offsetHeight);
      raiz.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
      raiz.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
      raiz.style.right = 'auto';
      raiz.style.bottom = 'auto';
    };
    const salvarPosicao = () => GM_setValue(chavePos, { x: raiz.offsetLeft, y: raiz.offsetTop });
    cab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === btnMin) return;
      const inicio = raiz.getBoundingClientRect();
      const dx = e.clientX - inicio.left;
      const dy = e.clientY - inicio.top;
      cab.setPointerCapture(e.pointerId);
      const mover = (ev) => posicionar(ev.clientX - dx, ev.clientY - dy);
      const soltar = () => {
        cab.removeEventListener('pointermove', mover);
        cab.removeEventListener('pointerup', soltar);
        salvarPosicao();
      };
      cab.addEventListener('pointermove', mover);
      cab.addEventListener('pointerup', soltar);
    });
    const guardada = GM_getValue(chavePos, null);
    if (guardada) posicionar(guardada.x, guardada.y);
    // se a janela do navegador diminuir, traz o painel de volta para dentro da tela
    window.addEventListener('resize', () => raiz.style.left && posicionar(raiz.offsetLeft, raiz.offsetTop));

    // minimizar / abrir no
