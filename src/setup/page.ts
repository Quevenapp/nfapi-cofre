// Tela de configuração do cofre, servida em /setup. É o painel do emitente.
//
// HTML, CSS e JS são arquivos separados (rotas próprias) para permitir uma CSP
// sem 'unsafe-inline'. O JS não usa innerHTML: todo texto vindo do servidor
// entra por textContent.

export const SETUP_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cofre NFapi</title>
<link rel="stylesheet" href="/setup/app.css">
</head>
<body>
<main>
	<header>
		<h1>Cofre NFapi</h1>
		<p class="muted">Seu emissor de notas fiscais: o certificado digital e os documentos ficam aqui, na sua conta Cloudflare.</p>
	</header>

	<section id="login" class="card">
		<h2>Entrar</h2>
		<p>Informe o segredo do cofre (<code>VAULT_SECRET</code>) definido na instalação.</p>
		<form id="login-form">
			<label for="secret">Segredo do cofre</label>
			<input id="secret" type="password" autocomplete="off" required>
			<button type="submit">Entrar</button>
		</form>
		<p id="login-error" class="error" role="alert"></p>
	</section>

	<div id="panel" hidden>
		<section class="card">
			<h2>1. Certificado digital A1</h2>
			<div id="cert-status"></div>
			<form id="cert-form">
				<label for="pfx">Arquivo do certificado (.pfx ou .p12)</label>
				<input id="pfx" type="file" accept=".pfx,.p12" required>
				<label for="pfx-password">Senha do certificado</label>
				<input id="pfx-password" type="password" autocomplete="off" required>
				<div class="row">
					<button type="submit">Instalar certificado</button>
					<button type="button" id="cert-remove" class="ghost danger" hidden>Remover</button>
				</div>
			</form>
			<p class="muted small">O arquivo é lido por este cofre, cifrado e gravado no seu banco D1. A senha não é guardada.</p>
			<p id="cert-message" role="status"></p>
		</section>

		<section class="card">
			<h2>2. Teste de conexão</h2>
			<p>Consulta o status dos serviços de <strong>homologação</strong> usando o certificado instalado. Nenhuma nota é emitida.</p>
			<button type="button" id="selftest">Testar conexão com o governo</button>
			<ul id="selftest-results" class="results"></ul>
		</section>

		<section class="card">
			<h2>3. Chaves de API</h2>
			<p>Os seus sistemas emitem notas chamando este cofre direto, com uma chave de API. Endereço da API: <code id="api-base"></code></p>
			<form id="apikey-form">
				<label for="apikey-name">Nome da chave (ex.: o sistema que vai usá-la)</label>
				<input id="apikey-name" type="text" maxlength="80" placeholder="Meu sistema">
				<label for="apikey-scope">O que a chave pode fazer</label>
				<select id="apikey-scope">
					<option value="completo">Homologação e produção</option>
					<option value="homologacao">Somente homologação (testes)</option>
				</select>
				<button type="submit">Criar chave de API</button>
			</form>
			<div id="apikey-box" hidden>
				<p class="warn">Copie agora: a chave aparece uma única vez.</p>
				<textarea id="apikey-value" readonly rows="2"></textarea>
				<button type="button" id="apikey-copy" class="ghost">Copiar chave</button>
			</div>
			<ul id="apikeys" class="results"></ul>
		</section>

		<section class="card">
			<h2>4. Ambiente</h2>
			<p id="env-status"></p>
			<button type="button" id="env-toggle" class="ghost"></button>
			<p class="muted small">Enquanto a produção estiver bloqueada, o cofre recusa assinar qualquer documento com valor fiscal.</p>
		</section>

		<section class="card">
			<h2>Notas emitidas</h2>
			<p class="muted small">Os arquivos ficam neste cofre. O cancelamento é registrado na SEFIN; o município define o prazo em que ele é aceito.</p>
			<p id="notes-empty" class="muted" hidden>Nenhuma nota arquivada neste cofre ainda.</p>
			<ul id="notes" class="notes"></ul>
			<p id="notes-message" role="status"></p>
		</section>

		<section class="card">
			<h2>Atualização</h2>
			<p id="update-status"></p>
			<div class="row">
				<button type="button" id="update-run" hidden>Atualizar agora</button>
				<button type="button" id="update-check" class="ghost">Verificar novamente</button>
			</div>
			<p id="update-message" role="status"></p>
			<details id="update-setup">
				<summary>Configurar o gatilho de atualização</summary>
				<p class="small">A atualização dispara um novo build deste cofre no Cloudflare. Crie o gatilho uma única vez:</p>
				<ol class="small">
					<li>No painel do Cloudflare, abra <strong>Workers &amp; Pages</strong> e selecione este Worker.</li>
					<li>Em <strong>Settings &gt; Builds &gt; Deploy Hooks</strong>, crie um gatilho para a branch <code>main</code>.</li>
					<li>Copie a URL gerada e cole abaixo.</li>
				</ol>
				<form id="hook-form">
					<label for="hook-url">URL do Deploy Hook</label>
					<input id="hook-url" type="password" autocomplete="off" placeholder="https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/..." required>
					<button type="submit" class="ghost">Salvar gatilho</button>
				</form>
				<p class="muted small">Quem tem essa URL consegue disparar builds, então ela fica guardada cifrada neste cofre.</p>
			</details>
		</section>

		<section class="card">
			<h2>Atividade recente</h2>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Quando</th><th>Ação</th><th>Quem</th><th>Resultado</th></tr></thead>
					<tbody id="audit"></tbody>
				</table>
			</div>
		</section>
	</div>

	<footer class="muted small"><span id="version"></span></footer>
</main>
<script src="/setup/app.js"></script>
</body>
</html>`;

export const SETUP_CSS = String.raw`:root {
	--bg: #f5f6f8; --card: #ffffff; --text: #16202c; --muted: #5b6776; --line: #d9dee5;
	--accent: #0b5cd6; --accent-text: #ffffff; --ok: #12773d; --bad: #b3261e; --warn: #8a5300;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0f141a; --card: #18202a; --text: #e7ecf2; --muted: #9aa7b6; --line: #2b3643;
		--accent: #5c9dff; --accent-text: #0b1420; --ok: #5fd08d; --bad: #ff8a80; --warn: #f2b65a;
	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
header { margin-bottom: 20px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
p { margin: 0 0 12px; }
ol { margin: 0 0 12px; padding-left: 20px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; overflow-wrap: anywhere; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.error, .bad { color: var(--bad); }
.ok { color: var(--ok); }
.warn { color: var(--warn); font-weight: 600; }
label { display: block; font-weight: 600; font-size: 0.9rem; margin: 12px 0 4px; }
input[type="text"], input[type="password"], input[type="file"], textarea, select {
	width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
	background: var(--bg); color: var(--text); font: inherit;
}
textarea { font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; word-break: break-all; resize: vertical; }
button {
	margin-top: 14px; padding: 10px 16px; border: 1px solid var(--accent); border-radius: 8px;
	background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer;
}
button.ghost { background: transparent; color: var(--accent); }
button.danger { border-color: var(--bad); color: var(--bad); }
button:disabled { opacity: 0.6; cursor: progress; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 12px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.results { list-style: none; margin: 14px 0 0; padding: 0; }
.results li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.results li button { margin-top: 0; padding: 6px 12px; }
.results .detail, .notes .detail { display: block; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
.notes { list-style: none; margin: 0; padding: 0; }
.notes > li { padding: 14px 0; border-top: 1px solid var(--line); }
.notes .head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-weight: 600; }
.notes .acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.notes .acts button { margin-top: 0; padding: 6px 12px; font-size: 0.9rem; }
.notes .cancel-form { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; border: 1px solid currentColor; font-size: 0.8rem; font-weight: 700; white-space: nowrap; }
details { margin-top: 14px; }
summary { cursor: pointer; color: var(--accent); font-weight: 600; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th, td { text-align: left; padding: 6px 10px 6px 0; border-top: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; border-top: 0; }
footer { text-align: center; margin-top: 24px; }
[hidden] { display: none !important; }`;

export const SETUP_JS = String.raw`(function () {
	"use strict";
	var secret = "";
	var state = null;
	var $ = function (id) { return document.getElementById(id); };

	function el(tag, props, children) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (k) {
			if (k === "text") node.textContent = props[k];
			else if (k === "onclick") node.addEventListener("click", props[k]);
			else node.setAttribute(k, props[k]);
		});
		(children || []).forEach(function (c) { node.appendChild(c); });
		return node;
	}
	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
	function date(iso) { return new Date(iso).toLocaleString("pt-BR"); }

	async function api(method, path, body) {
		var init = { method: method, headers: { authorization: "Bearer " + secret } };
		if (body instanceof FormData) init.body = body;
		else if (body !== undefined) {
			init.headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		var res = await fetch(path, init);
		var json = await res.json().catch(function () { return null; });
		if (!res.ok) {
			var detalhe = json && ((json.error && json.error.message) || (json.erro && json.erro.mensagem));
			throw new Error(detalhe || ("Erro HTTP " + res.status));
		}
		return json;
	}

	async function busy(button, task) {
		// Formulário enviado pelo teclado pode não informar o botão.
		if (button) button.disabled = true;
		try { return await task(); } finally { if (button) button.disabled = false; }
	}

	function message(id, text, kind) {
		var node = $(id);
		node.textContent = text;
		node.className = kind || "";
	}

	async function copiar(campo, botao, feito) {
		campo.select();
		try {
			await navigator.clipboard.writeText(campo.value);
			botao.textContent = feito;
		} catch (e) {
			document.execCommand("copy");
		}
	}

	// ---------- Certificado ----------

	function renderCertificate() {
		var box = $("cert-status");
		clear(box);
		var cert = state.certificate;
		$("cert-remove").hidden = !cert;
		if (!cert) {
			box.appendChild(el("p", { text: "Nenhum certificado instalado.", class: "warn" }));
			return;
		}
		var days = Math.floor((new Date(cert.notAfter) - Date.now()) / 86400000);
		var validity = date(cert.notAfter) + (days < 0 ? " — VENCIDO" : " — faltam " + days + " dias");
		var rows = [
			["Titular", cert.commonName],
			[cert.holder.kind.toUpperCase(), cert.holder.id],
			["Emissor", cert.issuer],
			["Validade", validity],
			["Instalado em", date(cert.installedAt)]
		];
		var dl = el("dl");
		rows.forEach(function (r) {
			dl.appendChild(el("dt", { text: r[0] }));
			dl.appendChild(el("dd", { text: r[1], class: r[0] === "Validade" && days < 30 ? "warn" : "" }));
		});
		box.appendChild(dl);
	}

	function renderEnvironment() {
		var on = state.allowProduction;
		$("env-status").textContent = on
			? "Produção LIBERADA: este cofre emite documentos com valor fiscal."
			: "Produção bloqueada: este cofre só emite documentos de homologação.";
		$("env-status").className = on ? "warn" : "ok";
		$("env-toggle").textContent = on ? "Bloquear produção" : "Liberar produção";
	}

	// ---------- Chaves de API ----------

	async function renderKeys() {
		$("api-base").textContent = location.origin + "/v1/nfse";
		var data = await api("GET", "/admin/chaves");
		var list = $("apikeys");
		clear(list);
		data.chaves.forEach(function (k) {
			var detalhe = k.prefixo + "… · " + (k.escopo === "homologacao" ? "somente homologação" : "homologação e produção") +
				" · criada em " + date(k.criadaEm) +
				(k.revogadaEm ? " · revogada em " + date(k.revogadaEm) : (k.ultimoUso ? " · último uso " + date(k.ultimoUso) : " · nunca usada"));
			var item = el("li", {}, [el("span", {}, [el("strong", { text: k.nome }), el("span", { class: "detail", text: detalhe })])]);
			if (!k.revogadaEm) {
				item.appendChild(el("button", {
					type: "button", class: "ghost danger", text: "Revogar",
					onclick: async function (ev) {
						if (!confirm("Revogar a chave \"" + k.nome + "\"? O sistema que a usa deixa de conseguir emitir.")) return;
						await busy(ev.currentTarget, function () { return api("DELETE", "/admin/chaves/" + k.id); });
						await renderKeys();
					}
				}));
			}
			list.appendChild(item);
		});
	}

	// ---------- Notas emitidas ----------

	var ARQUIVOS = { nfse: "XML da NFS-e", dps: "XML da DPS", cancelamento: "Evento de cancelamento" };

	async function baixar(arquivo) {
		var res = await fetch("/admin/notas/arquivo?key=" + encodeURIComponent(arquivo.key), {
			headers: { authorization: "Bearer " + secret }
		});
		if (!res.ok) throw new Error("Não foi possível baixar o arquivo (HTTP " + res.status + ").");
		var url = URL.createObjectURL(await res.blob());
		var link = el("a", { href: url, download: arquivo.nome });
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	function formCancelar(nota, item) {
		var motivo = el("select", {}, [
			el("option", { value: "erro_emissao", text: "Erro na emissão" }),
			el("option", { value: "servico_nao_prestado", text: "Serviço não prestado" }),
			el("option", { value: "outros", text: "Outros" })
		]);
		var justificativa = el("textarea", { rows: "2", maxlength: "255", placeholder: "Explique o motivo (mínimo de 15 caracteres)" });
		var confirmar = el("button", { type: "button", class: "ghost danger", text: "Confirmar cancelamento" });
		var desistir = el("button", { type: "button", class: "ghost", text: "Voltar" });
		var form = el("div", { class: "cancel-form" }, [
			el("label", { text: "Motivo" }), motivo,
			el("label", { text: "Justificativa" }), justificativa,
			el("div", { class: "row" }, [confirmar, desistir])
		]);
		desistir.addEventListener("click", function () { form.remove(); });
		confirmar.addEventListener("click", async function () {
			if (justificativa.value.trim().length < 15) return message("notes-message", "A justificativa precisa ter ao menos 15 caracteres.", "error");
			if (!confirm("Cancelar esta nota? O cancelamento é registrado na SEFIN e não pode ser desfeito.")) return;
			message("notes-message", "Registrando o cancelamento na SEFIN…");
			try {
				await busy(confirmar, function () {
					return api("POST", "/admin/notas/cancelar", {
						chaveAcesso: nota.chaveAcesso, motivo: motivo.value, justificativa: justificativa.value.trim()
					});
				});
				message("notes-message", "Nota cancelada.", "ok");
				await renderNotes();
				await renderAudit();
			} catch (err) {
				message("notes-message", err.message, "error");
			}
		});
		item.appendChild(form);
		justificativa.focus();
	}

	async function renderNotes() {
		var data = await api("GET", "/admin/notas");
		var list = $("notes");
		clear(list);
		$("notes-empty").hidden = data.notas.length > 0;
		data.notas.forEach(function (n) {
			var titulo = (n.numeroNfse ? "NFS-e nº " + n.numeroNfse : "NFS-e") +
				(n.serie ? " · série " + n.serie + ", DPS " + n.numeroDps : "");
			var cancelada = n.situacao === "cancelada";
			var detalhe = "Chave " + n.chaveAcesso +
				" · " + (n.ambiente === "producao" ? "produção" : "homologação") +
				(n.valor !== null ? " · R$ " + n.valor.toFixed(2).replace(".", ",") : "") +
				" · emitida em " + date(n.emitidaEm) +
				(cancelada && n.canceladaEm ? " · cancelada em " + date(n.canceladaEm) : "");
			var acts = el("div", { class: "acts" });
			n.arquivos.forEach(function (a) {
				var botao = el("button", { type: "button", class: "ghost", text: ARQUIVOS[a.tipo] || a.nome });
				botao.addEventListener("click", function () {
					busy(botao, function () { return baixar(a); }).catch(function (err) { message("notes-message", err.message, "error"); });
				});
				acts.appendChild(botao);
			});
			var item = el("li", {}, [
				el("div", { class: "head" }, [
					el("span", { text: titulo }),
					el("span", { class: "badge " + (cancelada ? "bad" : "ok"), text: cancelada ? "Cancelada" : "Autorizada" })
				]),
				el("span", { class: "detail", text: detalhe }),
				acts
			]);
			if (!cancelada) {
				var cancelar = el("button", { type: "button", class: "ghost danger", text: "Cancelar nota" });
				cancelar.addEventListener("click", function () {
					if (!item.querySelector(".cancel-form")) formCancelar(n, item);
				});
				acts.appendChild(cancelar);
			}
			list.appendChild(item);
		});
	}

	// ---------- Atualização ----------

	async function renderUpdate(verificar) {
		var u = await api("GET", "/admin/atualizacao" + (verificar ? "?verificar=1" : ""));
		var texto = "Versão instalada: " + u.instalada + ". ";
		if (!u.publicada) texto += "Não foi possível consultar a versão publicada agora.";
		else if (u.haAtualizacao) texto += "Há uma versão nova disponível: " + u.publicada + ".";
		else texto += "Este cofre está atualizado.";
		$("update-status").textContent = texto;
		$("update-status").className = u.haAtualizacao ? "warn" : "";
		// Sem conseguir consultar a versão publicada, o botão continua disponível.
		$("update-run").hidden = !(u.gatilhoConfigurado && (u.haAtualizacao || !u.publicada));
		$("update-run").textContent = u.haAtualizacao ? "Atualizar para " + u.publicada : "Atualizar agora";
		$("update-setup").open = !u.gatilhoConfigurado;
		$("update-setup").querySelector("summary").textContent = u.gatilhoConfigurado
			? "Trocar o gatilho de atualização"
			: "Configurar o gatilho de atualização";
	}

	async function renderAudit() {
		var data = await api("GET", "/admin/audit?limit=30");
		var body = $("audit");
		clear(body);
		data.entries.forEach(function (e) {
			body.appendChild(el("tr", {}, [
				el("td", { text: date(e.at) }),
				el("td", { text: e.action }),
				el("td", { text: e.actor }),
				el("td", { text: e.outcome, class: e.outcome === "ok" ? "ok" : "bad" })
			]));
		});
	}

	async function refresh() {
		state = await api("GET", "/admin/status");
		$("version").textContent = "Cofre NFapi v" + state.version;
		renderCertificate();
		renderEnvironment();
		await renderKeys();
		await renderNotes();
		await renderUpdate(false);
		await renderAudit();
	}

	$("login-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		secret = $("secret").value.trim();
		message("login-error", "");
		try {
			await refresh();
			$("secret").value = "";
			$("login").hidden = true;
			$("panel").hidden = false;
		} catch (err) {
			secret = "";
			message("login-error", err.message, "error");
		}
	});

	$("cert-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var form = new FormData();
		form.append("pfx", $("pfx").files[0]);
		form.append("password", $("pfx-password").value);
		message("cert-message", "Lendo o certificado…");
		try {
			await busy(ev.submitter, function () { return api("POST", "/admin/certificate", form); });
			$("pfx").value = "";
			$("pfx-password").value = "";
			message("cert-message", "Certificado instalado.", "ok");
			await refresh();
		} catch (err) {
			message("cert-message", err.message, "error");
		}
	});

	$("cert-remove").addEventListener("click", async function (ev) {
		if (!confirm("Remover o certificado do cofre? As emissões param até você instalar outro.")) return;
		await busy(ev.currentTarget, function () { return api("DELETE", "/admin/certificate"); });
		message("cert-message", "Certificado removido.");
		await refresh();
	});

	$("selftest").addEventListener("click", async function (ev) {
		var list = $("selftest-results");
		clear(list);
		list.appendChild(el("li", { text: "Testando… a primeira conexão pode levar alguns segundos." }));
		try {
			var data = await busy(ev.currentTarget, function () { return api("POST", "/admin/selftest"); });
			clear(list);
			data.results.forEach(function (r) {
				list.appendChild(el("li", {}, [
					el("span", {}, [
						el("strong", { text: r.name }),
						el("span", { class: "detail", text: r.detail })
					]),
					el("span", { class: r.ok ? "ok" : "bad", text: r.ok ? "OK" : "Falhou" })
				]));
			});
		} catch (err) {
			clear(list);
			list.appendChild(el("li", { class: "bad", text: err.message }));
		}
		await renderAudit();
	});

	$("apikey-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var data = await busy(ev.submitter, function () {
			return api("POST", "/admin/chaves", { nome: $("apikey-name").value || undefined, escopo: $("apikey-scope").value });
		});
		$("apikey-value").value = data.chave.valor;
		$("apikey-box").hidden = false;
		$("apikey-copy").textContent = "Copiar chave";
		$("apikey-name").value = "";
		await renderKeys();
	});

	$("apikey-copy").addEventListener("click", function () {
		copiar($("apikey-value"), $("apikey-copy"), "Copiada");
	});

	$("env-toggle").addEventListener("click", async function (ev) {
		var next = !state.allowProduction;
		if (next && !confirm("Liberar a produção? A partir de agora o cofre emite notas com valor fiscal.")) return;
		await busy(ev.currentTarget, function () { return api("PUT", "/admin/settings", { allowProduction: next }); });
		await refresh();
	});

	$("update-check").addEventListener("click", async function (ev) {
		message("update-message", "");
		await busy(ev.currentTarget, function () { return renderUpdate(true); });
	});

	$("update-run").addEventListener("click", async function (ev) {
		if (!confirm("Atualizar o cofre agora? Ele continua funcionando durante o build; a nova versão entra no ar em um ou dois minutos.")) return;
		try {
			var data = await busy(ev.currentTarget, function () { return api("POST", "/admin/atualizacao"); });
			message("update-message", data.mensagem + " Recarregue esta página depois.", "ok");
		} catch (err) {
			message("update-message", err.message, "error");
		}
		await renderAudit();
	});

	$("hook-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/atualizacao/gatilho", { url: $("hook-url").value.trim() }); });
			$("hook-url").value = "";
			message("update-message", "Gatilho salvo.", "ok");
			await renderUpdate(false);
		} catch (err) {
			message("update-message", err.message, "error");
		}
	});
})();`;
