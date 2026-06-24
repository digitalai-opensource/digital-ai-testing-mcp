# Supplemental Terms of Use — Digital.ai MCP Server for Testing

**Effective Date:** June 24, 2026  
**Version:** 1.0

---

These Supplemental Terms of Use ("Supplemental Terms") apply to your use of the Digital.ai MCP Server for Testing (the "Connector Software") and are incorporated into and supplement the Apache License, Version 2.0 (the "Apache 2.0 License") under which the Connector Software is distributed. By downloading, installing, configuring, or otherwise using the Connector Software, you ("User") agree to be bound by these Supplemental Terms in addition to the Apache 2.0 License. If you do not agree, do not use the Connector Software.

If your organization has a separately executed Master Software Agreement or other written agreement with Digital.ai, Inc. ("Digital.ai") that expressly governs your use of this Connector Software, that agreement controls to the extent of any conflict with these Supplemental Terms. These Supplemental Terms are intended to supplement, not replace, any such agreement.

---

## 1. Definitions

**"Connector Software"** means the Digital.ai MCP Server for Testing, including all associated code, configuration files, documentation, and container images distributed by Digital.ai via GitHub or other channels.

**"AI Client"** means any third-party artificial intelligence model, large language model, AI agent, AI coding assistant, or AI-enabled application (including but not limited to Anthropic Claude, GitHub Copilot, Cursor, or any other model or agent) that User connects to the Connector Software.

**"Agentic Action"** means any action initiated by an AI Client through the Connector Software that interacts with the Digital.ai Testing platform, including but not limited to: executing or modifying tests, rebooting or managing devices, quarantining or modifying test configurations, blocking or approving builds, accessing test results or analytics data, and any other read or write operation performed via the Connector Software's tool interface.

**"Testing Platform"** means Digital.ai's Testing platform and associated APIs that the Connector Software connects to.

**"Output"** means any data, results, recommendations, decisions, actions, or other content generated or initiated by an AI Client through use of the Connector Software.

## 2. Nature of the Connector Software

The Connector Software is a protocol middleware layer - it is not itself an artificial intelligence system. It implements the Model Context Protocol (MCP) open standard to enable User-selected AI Clients to interact with the Digital.ai Testing Platform APIs. Digital.ai does not select, control, operate, or endorse any AI Client that User connects to the Connector Software. All intelligence, decision-making, and action initiation originates from User's AI Client, not from Digital.ai or the Connector Software.

## 3. User Responsibilities

### 3.1 AI Client Selection and Configuration

User is solely responsible for selecting, configuring, securing, and operating any AI Client connected to the Connector Software. User represents and warrants that it has reviewed and complies with the terms of service of any AI Client it connects to the Connector Software.

### 3.2 Agentic Actions

User acknowledges that AI Clients connected to the Connector Software may initiate Agentic Actions on the Testing Platform autonomously and without individual human review of each action. User assumes full responsibility for all Agentic Actions taken by any AI Client through the Connector Software, including actions that are irreversible, that affect shared infrastructure, or that have downstream consequences on software release decisions, device availability, or test configurations.

### 3.3 Human Oversight

User is solely responsible for implementing appropriate human oversight, approval workflows, and access controls governing what Agentic Actions its AI Client is authorized to perform. Digital.ai strongly recommends that User configure permission scopes and require human confirmation for all consequential or irreversible Agentic Actions, including but not limited to device reboots, build blocking, and test quarantine operations.

### 3.4 Data Responsibility

User is solely responsible for ensuring that any data - including application screenshots, element trees, test results, device identifiers, or any other content - transmitted through the Connector Software to an AI Client does not violate applicable law, including data protection and privacy regulations (including without limitation GDPR, CCPA, HIPAA, or PCI-DSS), or any third-party rights. User must ensure it has all necessary rights, consents, and authorizations before transmitting any data through the Connector Software. Digital.ai is not responsible for data transmitted to or retained by any AI Client.

### 3.5 Credentials and Security

User is responsible for securing all API credentials, access tokens, and environment variables used to configure the Connector Software. User shall implement appropriate access controls to prevent unauthorized use of the Connector Software and shall promptly notify Digital.ai of any suspected unauthorized access or credential compromise.

### 3.6 Legal Compliance

User is responsible for ensuring its use of the Connector Software complies with all applicable laws and regulations in its jurisdiction, including but not limited to AI-specific regulations, export control laws, data protection laws, and sector-specific requirements applicable to User's industry.

## 4. Disclaimer of Warranties

THE CONNECTOR SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, DIGITAL.AI EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING WITHOUT LIMITATION:

- (a) ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, OR NON-INFRINGEMENT;
- (b) ANY WARRANTY THAT THE CONNECTOR SOFTWARE WILL OPERATE WITHOUT INTERRUPTION OR BE ERROR-FREE;
- (c) ANY WARRANTY AS TO THE ACCURACY, RELIABILITY, COMPLETENESS, OR QUALITY OF ANY OUTPUT GENERATED BY AN AI CLIENT THROUGH THE CONNECTOR SOFTWARE;
- (d) ANY WARRANTY THAT AGENTIC ACTIONS TAKEN BY AN AI CLIENT THROUGH THE CONNECTOR SOFTWARE WILL BE CORRECT, APPROPRIATE, OR FREE FROM ERROR; AND
- (e) ANY WARRANTY THAT THE CONNECTOR SOFTWARE WILL MEET USER'S REQUIREMENTS OR THAT USE OF THE CONNECTOR SOFTWARE WILL ACHIEVE ANY PARTICULAR RESULT.

USER ACKNOWLEDGES THAT AI CLIENTS ARE PROBABILISTIC SYSTEMS THAT MAY PRODUCE INCORRECT, UNEXPECTED, OR HARMFUL OUTPUTS AND ACTIONS, AND THAT DIGITAL.AI HAS NO CONTROL OVER AND BEARS NO RESPONSIBILITY FOR THE BEHAVIOR OF ANY AI CLIENT CONNECTED TO THE CONNECTOR SOFTWARE.

## 5. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:

### 5.1

IN NO EVENT SHALL DIGITAL.AI, ITS AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, LICENSORS, OR SERVICE PROVIDERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES ARISING OUT OF OR RELATED TO USER'S USE OF THE CONNECTOR SOFTWARE OR ANY AGENTIC ACTIONS TAKEN BY AN AI CLIENT THROUGH THE CONNECTOR SOFTWARE, INCLUDING WITHOUT LIMITATION DAMAGES FOR: LOSS OF PROFITS, LOSS OF REVENUE, LOSS OF BUSINESS, LOSS OF DATA, COST OF SUBSTITUTE GOODS OR SERVICES, BUSINESS INTERRUPTION, PRODUCTION OUTAGES, RELEASE FAILURES, OR DEVICE DAMAGE - REGARDLESS OF WHETHER SUCH DAMAGES WERE FORESEEABLE AND WHETHER DIGITAL.AI WAS ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

### 5.2

IN NO EVENT SHALL DIGITAL.AI'S TOTAL CUMULATIVE LIABILITY TO USER ARISING OUT OF OR RELATED TO THESE SUPPLEMENTAL TERMS OR THE CONNECTOR SOFTWARE, REGARDLESS OF THE FORM OF ACTION, EXCEED ONE HUNDRED U.S. DOLLARS (USD $100).

### 5.3

THE LIMITATIONS IN THIS SECTION 5 APPLY TO ALL CLAIMS, WHETHER BASED IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, STATUTE, OR ANY OTHER LEGAL THEORY, AND WHETHER OR NOT DIGITAL.AI HAS BEEN INFORMED OF THE POSSIBILITY OF SUCH DAMAGE.

### 5.4

SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF INCIDENTAL OR CONSEQUENTIAL DAMAGES. TO THE EXTENT SUCH LIMITATIONS ARE NOT PERMITTED UNDER APPLICABLE LAW, DIGITAL.AI'S LIABILITY SHALL BE LIMITED TO THE GREATEST EXTENT PERMITTED.

## 6. No Endorsement of AI Clients

Digital.ai does not endorse, certify, warrant, or represent the safety, accuracy, reliability, or fitness for any purpose of any AI Client compatible with the Connector Software. References to specific AI Clients (including Anthropic Claude, GitHub Copilot, or Cursor) are provided for interoperability purposes only and do not constitute an endorsement or partnership. User's relationship with any AI Client provider is governed solely by User's agreement with that provider.

## 7. Consequential Action Risk Acknowledgment

User expressly acknowledges and agrees that:

- (a) The Connector Software enables AI Clients to perform actions on the Testing Platform that may be irreversible, including device reboots, test quarantine, CI pipeline modifications, and build blocking;
- (b) Digital.ai is not responsible for any Agentic Action that causes unintended consequences, including but not limited to disruption of shared device availability, suppression of test failures, incorrect release gating decisions, or downstream production incidents;
- (c) User bears sole responsibility for implementing controls - including permission scoping, rate limiting, and human approval requirements - appropriate to the risk level of Agentic Actions User authorizes its AI Client to perform; and
- (d) Digital.ai's provision of the Connector Software does not constitute a recommendation that any particular Agentic Action is safe, appropriate, or advisable for User's specific environment.

## 8. Governing Law and Dispute Resolution

These Supplemental Terms shall be governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to its conflict of law provisions. Any dispute arising out of or relating to these Supplemental Terms shall be subject to the exclusive jurisdiction of the state and federal courts located in Delaware, and User hereby consents to such jurisdiction.

## 9. Severability

If any provision of these Supplemental Terms is held to be invalid, illegal, or unenforceable, the remaining provisions shall continue in full force and effect. The invalid or unenforceable provision shall be modified to the minimum extent necessary to make it enforceable.

## 10. Relationship to Apache 2.0 License and Patent Rights

### 10.1 Apache 2.0 License Primacy

These Supplemental Terms do not modify, supersede, or restrict any rights granted under the Apache 2.0 License with respect to copying, modification, distribution, or sublicensing of the Connector Software source code. In the event of a conflict between these Supplemental Terms and the Apache 2.0 License solely with respect to copyright and distribution rights, the Apache 2.0 License controls. In all other respects - including liability, warranty disclaimer, and User obligations - these Supplemental Terms control.

### 10.2 Patent License Grant

Subject to the terms and conditions of the Apache 2.0 License, Digital.ai hereby grants User a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in Section 10.3 below) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Connector Software, where such license applies only to those patent claims licensable by Digital.ai that are necessarily infringed by Digital.ai's contribution(s) alone or by combination of Digital.ai's contribution(s) with the Connector Software as distributed by Digital.ai. This patent license is granted solely as provided in Section 3 of the Apache 2.0 License and is subject to all conditions set forth therein.

### 10.3 Patent Retaliation

Consistent with Section 3 of the Apache 2.0 License, if User initiates patent litigation against Digital.ai or any contributor (including a cross-claim or counterclaim in a lawsuit) alleging that the Connector Software or any contribution incorporated within the Connector Software constitutes direct or contributory patent infringement, then the patent license granted to User under Section 10.2 and the Apache 2.0 License shall terminate as of the date such litigation is filed. For the avoidance of doubt, this termination applies only to the patent license; User's copyright license under the Apache 2.0 License is governed separately by the terms of that license.

### 10.4 No Additional Patent Rights

Nothing in these Supplemental Terms shall be construed as granting User any patent rights beyond those expressly set forth in the Apache 2.0 License. Digital.ai does not grant any express or implied license under any Digital.ai patent other than as described in Section 10.2 above.

## 11. Entire Agreement

These Supplemental Terms, together with the Apache 2.0 License and (if applicable) any separately executed written agreement between User's organization and Digital.ai, constitute the entire agreement between the parties with respect to the subject matter hereof and supersede all prior or contemporaneous understandings, representations, or agreements relating to the Connector Software.
