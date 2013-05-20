package com.axelor.wkf.workflow;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.inject.Inject;

import org.joda.time.DateTime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.axelor.auth.AuthUtils;
import com.axelor.auth.db.User;
import com.axelor.db.Model;
import com.axelor.meta.ActionHandler;
import com.axelor.wkf.IWorkflow;
import com.axelor.wkf.action.Action;
import com.axelor.wkf.db.Instance;
import com.axelor.wkf.db.InstanceCounter;
import com.axelor.wkf.db.InstanceHistory;
import com.axelor.wkf.db.Node;
import com.axelor.wkf.db.Transition;
import com.axelor.wkf.db.WaitingNode;
import com.axelor.wkf.db.Workflow;
import com.google.common.base.Preconditions;
import com.google.inject.persist.Transactional;

public class WorkflowService implements IWorkflow {
	
	protected Logger log = LoggerFactory.getLogger(WorkflowService.class);
	
	private Action actionWorkflow;
	private ActionHandler actionHandler;
	
	protected int maxNodeCounter;
	protected Map<Node, Integer> nodeCounters;
	protected Set<Node> executedNodes;
	protected Map<Node, Set<Transition>> waitingNodes;
	
	protected Instance instance;
	protected DateTime dateTime;
	protected User user;
	
	@Inject
	public WorkflowService ( Action actionWorkflow ){
		
		this.nodeCounters = new HashMap<Node, Integer>();
		this.executedNodes = new HashSet<Node>();
		this.waitingNodes = new HashMap<Node, Set<Transition>>();

		this.dateTime = new DateTime();
		this.user = AuthUtils.getUser();
		
		this.actionWorkflow = actionWorkflow;
		
	}

// ACTION REQUEST	
	
	/**
	 * Init the service from one instance.
	 * 
	 * 
	 */
	protected WorkflowService init (Workflow wkf, ActionHandler actionHandler) {

		Preconditions.checkNotNull(wkf);
		
		log.debug("INIT Wkf engine context ::: {}", actionHandler.getContext());

		this.actionHandler = actionHandler;
		this.maxNodeCounter = wkf.getMaxNodeCounter();
		this.instance = getInstance(wkf, (Long)actionHandler.getContext().get("id"));
		
		loadWaitingNodes( instance );
		loadExecutedNodes( instance );
		
		return this;
		
	}

// SPECIFIC GETTER	
	
	/**
	 * Get instance from one workflow and one object id. If we have no instance with this params,
	 * one instance is created.
	 * Set current instance of this with the instance found or create and return new current instance of this.
	 * 
	 * @param wkf
	 * 		Target workflow.
	 * @param id
	 * 		Model id.
	 * 
	 * @return
	 * 		The instance founded.
	 */
	@Override
	public Instance getInstance(Workflow wkf, long id){

		Instance instance = Instance.all().filter("self.workflow = ?1 AND self.metaModelId = ?2", wkf, id).fetchOne();
		
		if (instance != null){
			return instance;
		}
		else {
			return this.createInstance(wkf, id);
		}
		
	}
	
	/**
	 * Get workflow from class.
	 * 
	 * @param klass
	 * 		Target Class. The class must be extend Model.
	 * 
	 * @return
	 * 		The workflow founded.	
	 * 
	 * @see Model
	 */
	@Override
	public Workflow getWorkflow(String name){
		
		List<Workflow> workflows = Workflow.all()
				.filter("self.name = ?1 AND self.active = true", name)
				.fetch();
		
		for (Workflow workflow : workflows){
			return workflow;
		}
		
		return null;
		
	}

// RUN WKF

	@Override
	public Map<String, String> run( String wkf, ActionHandler handler ){
		
		updateInstance( init( getWorkflow(wkf), handler ).playNodes( instance.getNodes() ) );
		return actionWorkflow.getData();
		
	}

// PLAY WKF
	
	/**
	 * Play a set of nodes.
	 * 
	 * @param nodes
	 * 		A set of nodes.
	 * 
	 * @return
	 * 		Set of running nodes.
	 */
	protected Set<Node> playNodes(Set<Node> nodes){
		
		Set<Node> lastNodes = new HashSet<Node>();
		
		for (Node node : nodes){
			lastNodes.addAll( playNode( node ) );
		}
		
		return lastNodes;
		
	}
	
	/**
	 * Play a node.
	 * 
	 * @param node
	 * 		One node.
	 * 
	 * @return
	 * 		Set of running nodes.
	 */
	protected Set<Node> playNode(Node node){

		log.debug("Play node {}", node.getName());
		
		testMaxPassedNode(node);
		
		Set<Node> nodes = new HashSet<Node>();
		
		if ( !node.getEndTransitions().isEmpty() ){
			
			if ( isPlayable(node) ){

				if ( node.getAction() != null ){ actionWorkflow.execute( node.getAction().getName(), actionHandler ); }
				nodes.addAll( playTransitions( node.getEndTransitions() ) );
				counterAdd( instance, node );
				addExecutedNodes( node );
			}
			
		}
		else {

			if ( node.getAction() != null ){ actionWorkflow.execute( node.getAction().getName(), actionHandler ); }
			nodes.add( node );
			
		}
			
		return nodes;
	}
	
	/**
	 * Play transitions.
	 * 
	 * @param transitions
	 * 		List of transitions.
	 * @param endLogicOperator
	 * 		Operator logic (or, xor).
	 * 
	 * @return
	 * 		Set of running nodes.
	 */
	protected Set<Node> playTransitions(List<Transition> transitions){
		
		Set<Node> nodes = new HashSet<Node>();
		
		for ( Transition transition : transitions ){
			
			nodes.addAll( playTransition(transition) );
			
		}
		
		return nodes;
		
		
	}

	/**
	 * Play transition.
	 * 
	 * @param transition
	 * 		One transition.
	 * 
	 * @return
	 * 		Set of running nodes.
	 */
	protected Set<Node> playTransition(Transition transition) {

		log.debug("Play transition {}", transition.getName());
		
		Set<Node> nodes = new HashSet<Node>();
		
		addHistory( instance, transition );
		
		if (transition.getCondition() != null){

			actionWorkflow.execute( transition.getCondition().getName(), actionHandler );
			
			if ( !actionWorkflow.isInError( ) ){
				
				addWaitingNodes( transition );
				nodes.addAll( playNode( transition.getNextNode() ) );
			}
			else {
				nodes.add( transition.getStartNode() );
			}
			
		}
		else {
			
			addWaitingNodes( transition );
			nodes.addAll( playNode( transition.getNextNode() ) );
			
		}
		
		return nodes;
		
	}
	
// RAISING EXCEPTION
	
	/**
	 * Throw error if the counter for this node is greater than max node counter.
	 */
	protected void testMaxPassedNode (Node node) {
		
		int counter = 1;
		
		if (nodeCounters.containsKey(node)){
			
			counter += nodeCounters.get(node);
			
		}

		nodeCounters.put(node, counter);

		log.debug( "compteur {} ::: max {}", counter, this.maxNodeCounter );
		
		if (counter > this.maxNodeCounter) {
			throw new Error( String.format( "We passed by the node %s %d time", node.getName(), counter ) );
		}
		
	}

// HELPER	
	
	/**
	 * Load waiting nodes from instance
	 * 
	 * @param instance
	 * @return
	 */
	protected void loadWaitingNodes(Instance instance){
		
		waitingNodes.clear();
			
		for (WaitingNode waitingNode : instance.getWaitingNodes()){
			
			waitingNodes.put( waitingNode.getNode(), waitingNode.getTransitions() );
			
		}
	}
	
	/**
	 * Add waitingNode for next node of this transition if start logic operator of next node is AND.
	 * 
	 * @param transition
	 * 		Target transition
	 */
	protected void addWaitingNodes(Transition transition){
		
		Node node = transition.getNextNode();
		
		if (node.getLogicOperator().equals( AND )){
			
			if ( !waitingNodes.containsKey(node) ){ waitingNodes.put( node, new HashSet<Transition>() ); }

			waitingNodes.get( node ).add( transition );
			
		}
		
	}
	
	/**
	 * Add executedNodes if start logic operator of node is XOR.
	 * 
	 * @param transition
	 * 		Target transition
	 */
	protected void addExecutedNodes(Node node){
		
		if (node.getLogicOperator().equals( XOR )){
			executedNodes.add( node );
		}
		
	}
	
	/**
	 * Load executed nodes from instance
	 * 
	 * @param instance
	 * @return
	 */
	protected void loadExecutedNodes(Instance instance){
		
		executedNodes.clear();
		executedNodes.addAll( instance.getExecutedNodes() );
		
	}
	
	/**
	 * The node is playable if his start logic operator is different of XOR or equal and not executed.
	 * 
	 * @param node
	 * 		Target node.
	 * 
	 * @return
	 * 		True if the node is playable else false.
	 */
	protected boolean isPlayable( Node node ){
		
		if ( node.getLogicOperator().equals( XOR ) && executedNodes.contains( node ) ){
			return false;
		}
		else if ( node.getLogicOperator().equals( AND ) ){
			
			if ( waitingNodes.containsKey( node ) && !waitingNodes.get( node ).containsAll( node.getStartTransitions() ) ){
				
				return false;
				
			}
			else {
				
				waitingNodes.remove( node );
				return true;
				
			}
		}
		else {
			return true;
		}
	}
	
	/**
	 * Create new Instance for one wkf and one record.
	 * 
	 * @param wkf
	 * 		One workflow.
	 * @param id
	 * 		One id of one record.
	 * 
	 * @return
	 * 		New instance.
	 */
	@Transactional
	protected Instance createInstance(Workflow wkf, Long id){
		
		Instance instance = new Instance();
		
		instance.setWorkflow( wkf );
		instance.setMetaModelId( id );
		
		instance.setCreationDate( dateTime );
		instance.setCreationUser( user );
		
		instance.setNodes( new HashSet<Node>() );
		instance.setExecutedNodes( new HashSet<Node>() );
		instance.setWaitingNodes( new ArrayList<WaitingNode>() );

		instance.addNode( wkf.getNode() );
		
		return instance.save();
		
	}
	
	@Transactional
	protected Instance updateInstance(Set<Node> nodes){
		
		instance.clearNodes();
		instance.getNodes().addAll( nodes );
		instance.getExecutedNodes().addAll( executedNodes );
		
		return instance.save();
	}
	
	/**
	 * Add a new history in Instance from a transition.
	 * 
	 * @param instance
	 * 		Target instance.
	 * @param transition
	 * 		Target transition.
	 */
	protected void addHistory(Instance instance, Transition transition){
		
		InstanceHistory history = new InstanceHistory();
		
		history.setInstance( instance );
		history.setCreationDate( dateTime );
		history.setCreationUser( user );
		history.setTransition( transition );		
		instance.addHistory( history );
		
	}
	
	/**
	 * Increment counter of one node for one instance.
	 * 
	 * @param instance
	 * 		Target instance.
	 * @param node
	 * 		Target node.
	 */
	protected void counterAdd(Instance instance, Node node){
		
		InstanceCounter counter = InstanceCounter.all().filter("self.instance = ?1 AND self.node = ?2", instance, node).fetchOne();
		
		if (counter != null){
			counter.setCounter( counter.getCounter() + 1 );
		}
		else {
			
			counter = new InstanceCounter();
			counter.setInstance( instance );
			counter.setNode( node );
			counter.setCounter( 1 );
			instance.addCounter( counter );
			
		}
		
	}
	
}
