// public/scripts/utils/TemplateUtils.js

"use strict";

import { AssertUtils } from "./AssertUtils.js";
import { DomUtils } from "./DomUtils.js";
import { NormalizeUtils } from "./NormalizeUtils.js";

/**
 * Base class for HTML template-backed UI fragments.
 */
export class TemplateUtils {
    static template = null;
    static templateId = "";
    static templateFile = "index.html";
    static componentUrl = "";
    static isTemplateRootValidationEnabled = true;
    static rootId = "";
    static rootTagName = "";
    static rootClassName = "";

    /**
     * Loads this fragment's template once.
     *
     * @returns {Promise<void>}
     */
    static async load() {
        if (this.template === null) {
            this.template = await this.loadTemplate(this.templateId, this.componentUrl, this.templateFile);
        }
    }

    /**
     * Loads a template from a fragment-relative HTML file.
     *
     * @param {string} templateId - Template element id.
     * @param {string} componentUrl - Fragment import.meta.url.
     * @param {string} templateFile - Fragment-relative template file.
     * @returns {Promise<HTMLTemplateElement>} Loaded template.
     */
    static async loadTemplate(templateId, componentUrl, templateFile = "index.html") {
        const normalizedTemplateId = NormalizeUtils.requiredString(templateId, "Template id");
        const normalizedTemplateFile = NormalizeUtils.requiredString(templateFile, "Template file");
        const htmlUrl = new URL(`../templates/${normalizedTemplateFile}`, location.href).href;
        const response = await fetch(htmlUrl);

        if (!response.ok) {
            throw new Error(`Failed to load template "${normalizedTemplateId}" from ${htmlUrl}.`);
        }

        const html = await response.text();
        const holder = document.createElement("template");

        holder.innerHTML = html;

        const template = holder.content.querySelector(`#${normalizedTemplateId}`);

        if (!(template instanceof HTMLTemplateElement)) {
            throw new Error(`Template "${normalizedTemplateId}" was not found in ${htmlUrl}.`);
        }

        return template;
    }
    /**
     * Creates a fragment element.
     *
     * @param {*} data - Fragment data.
     * @returns {HTMLElement} Created element.
     */
    static create(data = {}) {
        if (this.template === null) {
            throw new Error(`${this.name}.load() must complete before create().`);
        }

        return this.buildElement(this.template, data);
    }

    /**
     * Builds an element from a template and updates it.
     *
     * @param {HTMLTemplateElement} template - Source template.
     * @param {*} data - Fragment data.
     * @returns {HTMLElement} Built element.
     */
    static buildElement(template, data = {}) {
        AssertUtils.instanceOf(template, HTMLTemplateElement, `${this.name} template`);

        const element = this.cloneTemplateElement(template);

        if (this.isTemplateRootValidationEnabled) {
            this.assertRootElement(element);
        }

        this.updateElement(element, data);

        return element;
    }

    /**
     * Updates an existing fragment element.
     *
     * @param {HTMLElement} element - Fragment root element.
     * @param {*} data - Fragment data.
     */
    static updateElement(element, data = {}) {
        this.assertRootElement(element);
        NormalizeUtils.object(data, `${this.name}.updateElement() data`);
    }

    /**
     * Clones the first root element from a template.
     *
     * @param {HTMLTemplateElement} template - Source template.
     * @returns {HTMLElement} Cloned root element.
     */
    static cloneTemplateElement(template) {
        AssertUtils.instanceOf(template, HTMLTemplateElement, `${this.name} template`);

        const clone = template.content.cloneNode(true);
        const element = clone.firstElementChild;

        AssertUtils.instanceOf(element, HTMLElement, `${this.name} template root`);

        return element;
    }

    /**
     * Validates a fragment root element using subclass root metadata.
     *
     * @param {*} element - Element to validate.
     * @returns {HTMLElement} Valid root element.
     */
    static assertRootElement(element) {
        DomUtils.assertElement(element);

        if (this.rootId) {
            DomUtils.assertId(element, this.rootId);
        }

        if (this.rootTagName) {
            DomUtils.assertTagName(element, this.rootTagName);
        }

        if (this.rootClassName) {
            DomUtils.assertClassName(element, this.rootClassName);
        }

        return element;
    }

}
